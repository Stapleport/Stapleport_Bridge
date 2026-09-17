// Stapleport_Bridge 入口：cron 触发中继 tick；HTTP 只留 /health 一条只读状态路由。
// 本 Worker 是通道 authority 的签名客户端：私钥只进 wrangler secret / .dev.vars，
// 零公网面（workers_dev:false）。第三方接入方自托管同一份代码，换自己的 key 即可。
import { privateKeyToAccount } from 'viem/accounts';
import { createTickLock } from '@stapleport/worker-kit';
import { loadConfig, deriveTopology } from './config.js';
import { relayForward, relayReverse, relayOutForward, relayOutReverse } from './relay.js';
import { harvestAll } from './harvest.js';
import { onboardingTick, onboardSummary } from './onboarding.js';

// isolate 内存 tick 锁（照 SelfSweep 口径：防同 isolate 重叠，跨 isolate 靠 ops 表抢占）。
// 2026-09-17 起走 kit createTickLock（lockMs 首个 tick 时从 cfg 取；KV 事故案底见 kit lock.js）
let tickLock = null;

export default {
    async scheduled(controller, env, ctx) {
        const cfg = loadConfig(env);
        tickLock ??= createTickLock({ lockMs: cfg.lockMs, tag: 'bridge' });
        if (!tickLock.tryAcquire()) return;

        const pk = String(env.BRIDGE_RELAYER_PRIVATE_KEY ?? '').trim();
        if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
            return console.log('[bridge] 未配置 BRIDGE_RELAYER_PRIVATE_KEY（wrangler secret put），空转');
        }
        if (!env.BRIDGE_DB) {
            return console.log('[bridge] 未绑定 BRIDGE_DB（D1 游标/幂等表无处落），空转');
        }
        const wallet = privateKeyToAccount(pk);
        cfg.relayerAddress = wallet.address;
        const db = env.BRIDGE_DB;

        console.log(`[bridge] tick 开始 relayer=${wallet.address} 通道数=${cfg.channels.length} 出向通道数=${cfg.outChannels.length} dryRun=${cfg.dryRun}`);

        // E流 onboarding 先行：申请制链自动注册/后配/开通道 → 押金人工门。
        // 整段 try/catch 包住：onboarding 挂了只丢本轮推进，绝不能影响既有四向中继。
        try {
            await onboardingTick(env, cfg, wallet, db);
        } catch (e) {
            console.log(`[bridge] onboarding 总异常（忽略，中继照常）：${String(e.message).slice(0, 160)}`);
        }
        // 链拓扑运行时派生：D1 onboard(active) 档案 + ChainRegistry 枚举并入 cfg
        //（vars 优先，零回归）；onboarding 本轮推进完的链在这里生效。
        try {
            const derived = await deriveTopology(env, cfg, db);
            if (derived.channels + derived.outChannels > 0) {
                console.log(`[bridge] tick 通道数 → ${cfg.channels.length} 出向 → ${cfg.outChannels.length}`);
            }
        } catch (e) {
            console.log(`[bridge] 拓扑派生异常（忽略，vars 通道照常）：${String(e.message).slice(0, 160)}`);
        }

        await relayForward(env, cfg, wallet, db);
        await relayReverse(env, cfg, wallet, db);
        await relayOutForward(env, cfg, wallet, db);
        await relayOutReverse(env, cfg, wallet, db);
        await harvestAll(env, cfg, wallet, db);
        console.log('[bridge] tick 结束');
    },

    async fetch(request, env) {
        const url = new URL(request.url);
        if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
            const cfg = loadConfig(env);
            const pkOk = /^0x[0-9a-fA-F]{64}$/.test(String(env.BRIDGE_RELAYER_PRIVATE_KEY ?? ''));
            let relayer = null;
            if (pkOk) {
                try {
                    relayer = privateKeyToAccount(String(env.BRIDGE_RELAYER_PRIVATE_KEY).trim()).address;
                } catch { /* 不暴露错误细节 */ }
            }
            return Response.json({
                ok: true,
                service: 'stapleport-bridge',
                configured: Boolean(relayer) && Boolean(env.BRIDGE_DB) && cfg.channels.length + cfg.outChannels.length > 0,
                relayer, // authority 地址 = 通道执行权槽位应指向这里
                channels: cfg.channels.map((c) => ({ chainIndex: c.chainIndex, srcToken: c.srcToken, stplToken: c.stplToken, covered: Boolean(c.covered) })),
                outChannels: cfg.outChannels.map((c) => ({ chainIndex: c.chainIndex, vault: c.vault, token: c.token, covered: Boolean(c.covered), router: c.router || null })),
                hub: cfg.hub,
                dryRun: cfg.dryRun,
                // E流 onboarding 摘要（只读 D1；未配/读不到 = null，不影响 health 本身）
                onboarding: env.BRIDGE_DB
                    ? await onboardSummary(env.BRIDGE_DB, cfg).catch(() => null)
                    : null,
            });
        }
        return new Response('not found', { status: 404 });
    },
};
