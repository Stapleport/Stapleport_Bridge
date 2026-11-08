// Stapleport_Bridge 入口：cron 触发中继 tick；HTTP 只留 /health 一条只读状态路由。
// 本 Worker 是通道 authority 的签名客户端：私钥只进 wrangler secret / .dev.vars，
// 零公网面（workers_dev:false）。第三方接入方自托管同一份代码，换自己的 key 即可。
import { privateKeyToAccount } from 'viem/accounts';
import { createTickLock } from '@stapleport/worker-kit';
import { loadConfig, deriveTopology } from './config.js';
import { relayForward, relayReverse, relayOutForward, relayOutReverse } from './relay.js';
import { relayRefunds } from './refund.js';
import { relayInstructions } from './instructions.js';
import { onboardingTick, onboardSummary } from './onboarding.js';

// isolate 内存 tick 锁（照 SelfSweep 口径：防同 isolate 重叠，跨 isolate 靠 ops 表抢占）。
// 2026-09-17 起走 kit createTickLock（lockMs 首个 tick 时从 cfg 取；KV 事故案底见 kit lock.js）
let tickLock = null;

// wallet 缓存（L1-2，CPU 优化）：privateKeyToAccount = secp256k1 点乘（每 tick 固定开销），
// isolate 内按 pk 串缓存（分层钥最多 3 把：base/hub/fee；换 secret → 键变天然失效；
// 派生抛错不落缓存，保持原 throw 语义）。
const PK_RE = /^0x[0-9a-fA-F]{64}$/;
const walletCache = new Map();
function walletOf(pk) {
    const hit = walletCache.get(pk);
    if (hit) return hit;
    const w = privateKeyToAccount(pk); // 抛错在前：不落缓存
    walletCache.set(pk, w);
    return w;
}

// 分层签名钥（lib/tx.js resolveSigner 消费）：
//   base = BRIDGE_RELAYER_PRIVATE_KEY（既有单钥语义：源链/spoke 腿与全部未分层发送）
//   hub  = BRIDGE_HUB_RELAYER_PRIVATE_KEY（hub 通道 authority 钥；executeMint/executeOutRelease/executeOutRefund）
//   fee  = BRIDGE_FEE_CLAIM_RELAYER_PRIVATE_KEY（hub dir2 领奖槽 feeClaimAuthority 钥）
// 缺省安全：可选钥「未配置」→ 回落 base（单钥部署零回归）；「配了但格式非法」→ 该层置 null，
// sendTx 见 null 直接空转跳过（绝不回落到别的钥误签）。
function readKey(env, name) {
    const raw = env[name];
    const pk = String(raw ?? '').trim();
    return { pk, present: pk.length > 0, valid: PK_RE.test(pk) };
}

function buildSigner(env) {
    const base = readKey(env, 'BRIDGE_RELAYER_PRIVATE_KEY');
    if (!base.valid) return { error: '未配置 BRIDGE_RELAYER_PRIVATE_KEY（wrangler secret put），空转' };
    const baseWallet = walletOf(base.pk);
    const signer = { base: baseWallet, src: baseWallet };

    const hub = readKey(env, 'BRIDGE_HUB_RELAYER_PRIVATE_KEY');
    if (hub.valid) signer.hub = walletOf(hub.pk);
    else if (hub.present) {
        signer.hub = null;
        console.log('[bridge] BRIDGE_HUB_RELAYER_PRIVATE_KEY 格式非法（需 0x+64 hex），hub 腿空转不误签');
    } else signer.hub = baseWallet; // 单钥部署兼容

    const fee = readKey(env, 'BRIDGE_FEE_CLAIM_RELAYER_PRIVATE_KEY');
    if (fee.valid) signer.fee = walletOf(fee.pk);
    else if (fee.present) {
        signer.fee = null;
        console.log('[bridge] BRIDGE_FEE_CLAIM_RELAYER_PRIVATE_KEY 格式非法（需 0x+64 hex），dir2 领奖腿空转不误签');
    } else signer.fee = baseWallet; // 默认=feeClaimAuthority 旧口径（relayer 钥兼领奖）

    return { signer };
}

export { buildSigner };

export default {
    async scheduled(controller, env, ctx) {
        const cfg = loadConfig(env);
        tickLock ??= createTickLock({ lockMs: cfg.lockMs, tag: 'bridge' });
        if (!tickLock.tryAcquire()) return;

        const built = buildSigner(env);
        if (built.error) return console.log(`[bridge] ${built.error}`);
        const wallet = built.signer;
        // relayerAddress/ hubRelayerAddress 供 onboarding/health/日志核对（权威地址仍以链上读回为准）
        cfg.relayerAddress = wallet.base.address;
        cfg.hubRelayerAddress = wallet.hub?.address ?? null;
        cfg.feeRelayerAddress = wallet.fee?.address ?? null;
        if (!env.BRIDGE_DB) {
            return console.log('[bridge] 未绑定 BRIDGE_DB（D1 游标/幂等表无处落），空转');
        }
        const db = env.BRIDGE_DB;

        console.log(`[bridge] tick 开始 relayer=${wallet.base.address} hubRelayer=${cfg.hubRelayerAddress ?? '(缺钥/空转)'} 通道数=${cfg.channels.length} 出向通道数=${cfg.outChannels.length} dryRun=${cfg.dryRun}`);

        // E流 onboarding 先行：申请制链自动注册/后配 → 检测人工已开通道转 active（开通道 MANAGE-only）。
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

        // 五腿逐腿容错：单腿挂了只丢该腿本轮推进，catch 后继续下一腿（下轮重试），
        // 不许单腿异常截断整轮 tick（写法照 relayInstructions 先例）。
        try { await relayForward(env, cfg, wallet, db); } catch (e) { console.log(`[bridge] 入向正向腿总异常（忽略，下轮重试）：${String(e.message).slice(0, 160)}`); }
        try { await relayReverse(env, cfg, wallet, db); } catch (e) { console.log(`[bridge] 入向反向腿总异常（忽略，下轮重试）：${String(e.message).slice(0, 160)}`); }
        try { await relayOutForward(env, cfg, wallet, db); } catch (e) { console.log(`[bridge] 出向正向腿总异常（忽略，下轮重试）：${String(e.message).slice(0, 160)}`); }
        try { await relayOutReverse(env, cfg, wallet, db); } catch (e) { console.log(`[bridge] 出向反向腿总异常（忽略，下轮重试）：${String(e.message).slice(0, 160)}`); }
        // 退款腿：过期落地指令事件 → 退款动作（时间有效性闭环；跑在四向中继之后）
        try { await relayRefunds(env, cfg, wallet, db); } catch (e) { console.log(`[bridge] 退款腿总异常（忽略，下轮重试）：${String(e.message).slice(0, 160)}`); }
        // 通用指令信封腿（v2 §2.1）：既有五腿之后（§2.3 tick 序=既有五腿→relayInstructions）。
        // 未配 registry/对拍不一致时内部空转/拒启，异常自吞，不影响既有腿。
        try { await relayInstructions(env, cfg, wallet, db); } catch (e) { console.log(`[bridge] 指令腿总异常（忽略）：${String(e.message).slice(0, 160)}`); }
        console.log('[bridge] tick 结束');
    },

    async fetch(request, env) {
        const url = new URL(request.url);
        if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
            const cfg = loadConfig(env);
            const built = buildSigner(env);
            let relayer = null;
            let hubRelayer = null;
            let feeRelayer = null;
            try {
                relayer = built.signer?.base?.address ?? null;
                hubRelayer = built.signer?.hub?.address ?? null;
                feeRelayer = built.signer?.fee?.address ?? null;
            } catch { /* 不暴露错误细节 */ }
            return Response.json({
                ok: true,
                service: 'stapleport-bridge',
                configured: Boolean(relayer) && Boolean(env.BRIDGE_DB) && cfg.channels.length + cfg.outChannels.length > 0,
                relayer, // base 钥地址（源链/spoke 腿 authority 应指向这里）
                hubRelayer, // hub 通道 authority 应指向这里（未分层时=relayer）
                feeRelayer, // hub dir2 领奖槽 feeClaimAuthority 应指向这里
                channels: cfg.channels.map((c) => ({ chainIndex: c.chainIndex, srcToken: c.srcToken, spToken: c.spToken })),
                outChannels: cfg.outChannels.map((c) => ({ chainIndex: c.chainIndex, vault: c.vault, token: c.token })),
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
