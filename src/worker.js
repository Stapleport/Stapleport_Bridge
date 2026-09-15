// Stapleport_Bridge 入口：cron 触发中继 tick；HTTP 只留 /health 一条只读状态路由。
// 本 Worker 是通道 authority 的签名客户端：私钥只进 wrangler secret / .dev.vars，
// 零公网面（workers_dev:false）。第三方接入方自托管同一份代码，换自己的 key 即可。
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from './config.js';
import { relayForward, relayReverse } from './relay.js';
import { harvestAll } from './harvest.js';

// isolate 内存 tick 锁（照 SelfSweep 口径：防同 isolate 重叠，跨 isolate 靠 ops 表抢占）
let tickLockUntil = 0;

export default {
    async scheduled(controller, env, ctx) {
        const cfg = loadConfig(env);
        const now = Date.now();
        if (now < tickLockUntil) return console.log('[bridge] tick 锁内，跳过本轮');
        tickLockUntil = now + cfg.lockMs;

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

        console.log(`[bridge] tick 开始 relayer=${wallet.address} 通道数=${cfg.channels.length} dryRun=${cfg.dryRun}`);
        await relayForward(env, cfg, wallet, db);
        await relayReverse(env, cfg, wallet, db);
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
                configured: Boolean(relayer) && Boolean(env.BRIDGE_DB) && cfg.channels.length > 0,
                relayer, // authority 地址 = 通道执行权槽位应指向这里
                channels: cfg.channels.map((c) => ({ chainIndex: c.chainIndex, srcToken: c.srcToken, zmToken: c.zmToken, covered: Boolean(c.covered) })),
                hub: cfg.hub,
                dryRun: cfg.dryRun,
            });
        }
        return new Response('not found', { status: 404 });
    },
};
