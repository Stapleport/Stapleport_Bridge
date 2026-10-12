// 配置装载：vars（JSON 字符串）+ registry.json 为底，env 覆盖。
// registry.json 由 scripts/sync-registry.mjs 从 Stapleport_hardhat/deployments/all.json 同步。
//
// E流 链拓扑运行时派生层（deriveTopology）：vars 之外的链/通道从
// D1 onboard(status='active') 档案 + hub ChainRegistry 枚举拼装进运行时 config。
// 合并优先级（保证生产行为零回归）：
//   vars（CHANNELS/OUT_CHANNELS/SRC_CHAINS/RPC_URL_*）> D1 onboard 档案 > ChainRegistry 链清单；
// 同 chainIndex 的 vars 条目存在时派生条目直接丢弃（只增不改，绝不覆盖 vars）。
import registry from '../registry.json' with { type: 'json' };
import { encodeFunctionData, decodeFunctionResult } from 'viem';
import { lockMsFromEnv } from '@stapleport/worker-kit';
import { callRaw, registerRpcGroup } from './lib/rpc.js';
import { registryAbi } from './lib/abi.js';
import { listOnboardByStatus } from './lib/store.js';

const chainReg = (chainId) => registry.chains?.[String(chainId)] ?? null;

export function loadConfig(env) {
    const hubChainId = String(env.HUB_CHAIN_ID || '78753');
    const hubReg = chainReg(hubChainId);
    const spBridge = env.SPBRIDGE || hubReg?.StapleportBridge?.address || null;
    const hubRpc = env.RPC_URL_HUB || hubReg?.meta?.rpc || null;
    if (!hubRpc || !spBridge) {
        console.log('[bridge] hub 未配齐（RPC_URL_HUB / SPBRIDGE / registry），反向与 mint 全部空转');
    }

    // 通道清单：本 relayer key 作为 authority 服务的通道
    // [{ chainIndex, srcToken, spToken, srcDecimals, vault }]
    // vault/rpc 按通道与 SRC_CHAINS 直配——chainIndex 是注册表索引，与 registry.json 的
    // chainId 键是两个维度，不可互查（registry 只服务 hub 端地址查找）
    const channels = JSON.parse(env.CHANNELS || '[]').map((c) => ({
        ...c,
        vault: c.vault || null,
        rpcUrl: srcChainsRpc(env, c.chainIndex),
        confirmations: BigInt(srcChainsConf(env, c.chainIndex)),
    }));

    // 出向通道清单：本 relayer 在外链侧服务 OutVault（spN 表示币宿主）的通道
    // [{ chainIndex, vault(OutVault), token(spN), srcToken? }]——18:18 无精度换算
    // token = spoke 侧 spN(OutToken)
    // srcToken = hub 侧锁仓 ERC20（ERC20 出向 mod；裁决：字段名 srcToken，与合约侧对齐）；
    //   presence ⇒ ERC20 出向通道；缺省 = native 出向通道（走既有 executeOutRelease/outReleased/outStanding 口）
    const outChannels = JSON.parse(env.OUT_CHANNELS || '[]').map((c) => ({
        ...c,
        token: c.token || null,
        srcToken: c.srcToken || null,
        vault: c.vault || null,
        rpcUrl: srcChainsRpc(env, c.chainIndex),
        confirmations: BigInt(srcChainsConf(env, c.chainIndex)),
    }));

    // 源链清单：chainIndex → { rpcUrl, confirmations }（入向/出向通道按 chainIndex 归并）
    const srcChains = {};
    for (const c of [...channels, ...outChannels]) {
        if (!srcChains[c.chainIndex]) {
            const rpcUrls = srcChainsRpcs(env, c.chainIndex);
            srcChains[c.chainIndex] = {
                rpcUrl: rpcUrls[0] ?? null, // primary；备援条见 rpcUrls（lib/rpc.js 失败轮换）
                rpcUrls,
                confirmations: BigInt(srcChainsConf(env, c.chainIndex)),
            };
        }
    }

    return {
        hub: { chainId: hubChainId, rpcUrl: hubRpc, spBridge },
        channels,
        outChannels,
        srcChains,
        relayerAddress: null, // worker.js 里由 key 派生后回填
        dryRun: String(env.DRY_RUN || 'false') === 'true',
        lockMs: lockMsFromEnv(env), // kit 护栏版：0/非数字落默认 55s（原裸 Number(|| 55) 无护栏）
        maxAttempts: Number(env.MAX_ATTEMPTS || 16), // 16≈每 tick 一次×15min 窗口+退款落地余量 1
        defaultGas: BigInt(env.DEFAULT_GAS || 600000),
        // gas 预估余量倍数（×10 整数，供 kit gasPrecheck headroomX10）：环境变量 TX_GAS_HEADROOM
        // （parseFloat；默认 1.2；下限 1.0，非数/低于下限回落默认）。executor 类目标 dev 节点
        // eth_estimateGas 欠报（t6c §3）时经 env 抬高（如 1.6）。
        gasHeadroomX10: gasHeadroomX10FromEnv(env),
        webhookUrl: env.WEBHOOK_URL || '',
        // ---- 费率准入面（bridge-fee-design §3.2/§3.3；乘数经 kit 单源引用）----
        oracleBase: String(env.ORACLE_BASE || '').trim().replace(/\/+$/, ''), // GET ${oracleBase}/gas?chainId=
        admitWindow: 5,          // 准入窗口（分钟，对齐链上 BRIDGE_WINDOW=5min）
        adjudicateBufferSec: 120, // deadline 后缓冲（秒）→ 转过期裁决腿（D4）
        stuckThreshold: 5,       // 退款/领奖腿预估连续失败阈值 → 卡死终态停试（追派二；独立于 MAX_ATTEMPTS）
        // 注：费率乘数（奖励/准入倍数）不在本仓重抄——单一出处 = kit bridgefee，runtime 经 lib/fee.js 消费。
        // ---- E流 onboarding（可选；API_BASE 空 = 关闭，行为与旧版完全一致）----
        apiBase: String(env.API_BASE || '').trim().replace(/\/+$/, ''),
    };
}

// gas 余量倍数 env 解析：TX_GAS_HEADROOM parseFloat，默认 1.2，下限 1.0（非数/低于下限回落默认）。
// 返回 ×10 整数（BigInt）对齐 kit gasPrecheck headroomX10。
function gasHeadroomX10FromEnv(env) {
    const h = parseFloat(env.TX_GAS_HEADROOM);
    const v = Number.isFinite(h) && h >= 1.0 ? h : 1.2;
    return BigInt(Math.round(v * 10));
}

// 源链 rpc 列表（RPC 单点缓解）：来源优先序=RPC_URL_<idx>（单条）→ SRC_CHAINS[idx].rpc（单条或
// 数组）→ SRC_CHAINS[idx].rpcs（数组）。去重保序，首条=primary（rpcUrl），多条组注册进
// lib/rpc.js 做失败轮换（primary 抛错时顺次试备援，粘住最近可用条）。onboarding spoke 侧同用此口径。
function srcChainsRpcs(env, chainIndex) {
    const row = JSON.parse(env.SRC_CHAINS || '{}')[String(chainIndex)] || {};
    const out = [];
    const push = (v) => {
        for (const u of (Array.isArray(v) ? v : [v])) if (u && !out.includes(u)) out.push(u);
    };
    push(env[`RPC_URL_${chainIndex}`]);
    push(row.rpc);
    push(row.rpcs);
    if (out.length > 1) registerRpcGroup(out);
    return out;
}

function srcChainsRpc(env, chainIndex) {
    return srcChainsRpcs(env, chainIndex)[0] ?? null;
}

function srcChainsConf(env, chainIndex) {
    return JSON.parse(env.SRC_CHAINS || '{}')[String(chainIndex)]?.confirmations ?? 3;
}
export { srcChainsRpc, srcChainsRpcs, srcChainsConf };

// ---------------- 运行时派生层（E流） ----------------
// 从 D1 onboard(status='active') 档案 + hub ChainRegistry 枚举拼装 vars 之外的
// CHANNELS/OUT_CHANNELS/SRC_CHAINS 并并入 cfg（原地追加，relay.js 消费形状不变）。
// vars 永远优先：同 chainIndex 的 vars 条目存在时派生条目丢弃；ChainRegistry 枚举
// 可用时还兼校准——链被 merge/停用则派生条目摘除（vars 条目不受影响）。
export async function deriveTopology(env, cfg, db) {
    const summary = { onboardRows: 0, channels: 0, outChannels: 0, skipped: 0 };
    if (!db || !cfg.hub.rpcUrl || !cfg.hub.spBridge) return summary;
    let rows;
    try {
        rows = await listOnboardByStatus(db, 'active');
    } catch (e) {
        console.log(`[bridge] 派生层读 onboard 表失败（跳过派生）：${String(e.message).slice(0, 120)}`);
        return summary;
    }
    summary.onboardRows = rows.length;
    if (rows.length === 0) return summary;

    const registryChains = await enumerateRegistryChains(cfg); // chainIndex → {evmChainId, rpc}；枚举失败 = null（降级）
    for (const row of rows) {
        const idx = String(row.chain_index ?? '');
        if (!idx || idx === '0') continue; // 未拿到索引的残行不派生
        let detail = {};
        try { detail = JSON.parse(row.detail || '{}'); } catch { /* 档案坏了按空处理 */ }
        // 校准：枚举可用而该索引已不在（合并/停用）→ 摘除，等链方/桥方处理
        if (registryChains && !registryChains[idx]) {
            summary.skipped++;
            continue;
        }
        const varsHasChannel = cfg.channels.some((c) => String(c.chainIndex) === idx);
        if (!varsHasChannel && detail.vault && detail.spToken) {
            cfg.channels.push({
                chainIndex: idx,
                srcToken: detail.srcToken ?? ZERO_ADDR, // 申请制链入向 native：srcToken=address(0)
                spToken: detail.spToken,
                srcDecimals: detail.srcDecimals ?? 18,
                vault: detail.vault,
            });
            summary.channels++;
        }
        const varsHasOut = cfg.outChannels.some((c) => String(c.chainIndex) === idx);
        if (!varsHasOut && detail.outVault && detail.outToken) {
            cfg.outChannels.push({
                chainIndex: idx,
                vault: detail.outVault,
                token: detail.outToken,
            });
            summary.outChannels++;
        }
        if (!cfg.srcChains[idx]) {
            const urls = srcChainsRpcs(env, idx);
            for (const extra of [registryChains?.[idx]?.rpc, detail.rpc]) {
                if (extra && !urls.includes(extra)) urls.push(extra);
            }
            if (urls.length > 1) registerRpcGroup(urls);
            cfg.srcChains[idx] = {
                rpcUrl: urls[0] ?? null,
                rpcUrls: urls,
                confirmations: BigInt(srcChainsConf(env, idx)),
            };
        }
    }
    if (summary.channels + summary.outChannels > 0) {
        console.log(`[bridge] 派生层并入：通道 +${summary.channels} 出向 +${summary.outChannels}（vars 优先，跳过 ${summary.skipped}）`);
    }
    return summary;
}

// hub ChainRegistry 枚举：nextIndex() 1..n-1 逐个 resolve，过滤 active+未合并
// （resolve 已穿透合并，终链 mergedInto 恒 0；枚举失败返回 null，派生降级为纯 D1 档案）
async function enumerateRegistryChains(cfg) {
    try {
        // 链注册表宿主 = spBridge 门面（去费版直读门面，无 registry() 中转口）
        const n = decodeFunctionResult({
            abi: registryAbi, functionName: 'nextIndex',
            data: await callRaw(cfg.hub.rpcUrl, cfg.hub.spBridge,
                encodeFunctionData({ abi: registryAbi, functionName: 'nextIndex' })),
        });
        const map = {};
        for (let i = 1n; i < n; i++) {
            const r = decodeFunctionResult({
                abi: registryAbi, functionName: 'resolve',
                data: await callRaw(cfg.hub.rpcUrl, cfg.hub.spBridge,
                    encodeFunctionData({ abi: registryAbi, functionName: 'resolve', args: [i] })),
            });
            // viem 双返回值解码为 { finalIdx, chain }；防御性兼容数组形态
            const finalIdx = Array.isArray(r) ? r[0] : r.finalIdx;
            const chain = Array.isArray(r) ? r[1] : r.chain;
            if (!chain?.active || BigInt(chain.mergedInto ?? 0n) !== 0n) continue;
            map[finalIdx.toString()] = { evmChainId: Number(chain.evmChainId), rpc: chain.rpc };
        }
        return map;
    } catch (e) {
        console.log(`[bridge] ChainRegistry 枚举失败（派生降级为 D1 档案）：${String(e.message).slice(0, 120)}`);
        return null;
    }
}

// 派生层本地零地址（不从 relay.js 引——relay 已反向 import 本仓 config，避免环）
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

// 精度换算：源币 → 18 位映射币（无损放大，仅在 srcDecimals ≤ 18 时无损；恒为放大方向）
export const to18 = (amount, srcDecimals) => amount * 10n ** BigInt(18 - srcDecimals);
// 18 位映射币 → 源币（floor，尾差留在 Vault 池内——池只多不少）
export const from18 = (amount, srcDecimals) => amount / 10n ** BigInt(18 - srcDecimals);
