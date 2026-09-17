// 配置装载：vars（JSON 字符串）+ registry.json 为底，env 覆盖。
// registry.json 由 scripts/sync-registry.mjs 从 Stapleport_hardhat/deployments/all.json 同步。
//
// E流 链拓扑运行时派生层（deriveTopology）：vars 之外的链/通道从
// D1 onboard(status='active') 档案 + hub ChainRegistry 枚举拼装进运行时 config。
// 合并优先级（保证生产行为零回归）：
//   vars（CHANNELS/OUT_CHANNELS/SRC_CHAINS/RPC_URL_*）> D1 onboard 档案 > ChainRegistry 链清单；
// 同 chainIndex 的 vars 条目存在时派生条目直接丢弃（只增不改，绝不覆盖 vars）。
import registry from '../registry.json' with { type: 'json' };
import { encodeFunctionData, decodeFunctionResult, parseEther } from 'viem';
import { lockMsFromEnv } from '@stapleport/worker-kit';
import { callRaw } from './lib/rpc.js';
import { registryAbi, stplBridgeAbi } from './lib/abi.js';
import { listOnboardByStatus } from './lib/store.js';

const chainReg = (chainId) => registry.chains?.[String(chainId)] ?? null;

export function loadConfig(env) {
    const hubChainId = String(env.HUB_CHAIN_ID || '78753');
    const hubReg = chainReg(hubChainId);
    const stplBridge = env.STPLBRIDGE || hubReg?.StapleportBridge?.address || null;
    const stakePool = env.STAKEPOOL || hubReg?.StakePool?.address || null;
    const hubRpc = env.RPC_URL_HUB || hubReg?.meta?.rpc || null;
    if (!hubRpc || !stplBridge) {
        console.log('[bridge] hub 未配齐（RPC_URL_HUB / STPLBRIDGE / registry），反向与 mint 全部空转');
    }

    // 通道清单：本 relayer key 作为 authority 服务的通道
    // [{ chainIndex, srcToken, stplToken, srcDecimals, vault, covered? }]
    // vault/rpc 按通道与 SRC_CHAINS 直配——chainIndex 是注册表索引，与 registry.json 的
    // chainId 键是两个维度，不可互查（registry 只服务 hub 端地址查找）
    const channels = JSON.parse(env.CHANNELS || '[]').map((c) => ({
        ...c,
        vault: c.vault || null,
        rpcUrl: srcChainsRpc(env, c.chainIndex),
        confirmations: BigInt(srcChainsConf(env, c.chainIndex)),
    }));

    // 出向通道清单：本 relayer 在外链侧服务 OutVault（stplN 表示币宿主）的通道
    // [{ chainIndex, vault(OutVault), token(stplN), covered?, router? }]——18:18 无精度换算
    const outChannels = JSON.parse(env.OUT_CHANNELS || '[]').map((c) => ({
        ...c,
        vault: c.vault || null,
        rpcUrl: srcChainsRpc(env, c.chainIndex),
        confirmations: BigInt(srcChainsConf(env, c.chainIndex)),
    }));

    // 源链清单：chainIndex → { rpcUrl, confirmations }（入向/出向通道按 chainIndex 归并）
    const srcChains = {};
    for (const c of [...channels, ...outChannels]) {
        if (!srcChains[c.chainIndex]) {
            srcChains[c.chainIndex] = {
                rpcUrl: srcChainsRpc(env, c.chainIndex),
                confirmations: BigInt(srcChainsConf(env, c.chainIndex)),
            };
        }
    }

    return {
        hub: { chainId: hubChainId, rpcUrl: hubRpc, stplBridge, stakePool },
        channels,
        outChannels,
        srcChains,
        relayerAddress: null, // worker.js 里由 key 派生后回填
        dryRun: String(env.DRY_RUN || 'false') === 'true',
        lockMs: lockMsFromEnv(env), // kit 护栏版：0/非数字落默认 55s（原裸 Number(|| 55) 无护栏）
        maxAttempts: Number(env.MAX_ATTEMPTS || 10),
        defaultGas: BigInt(env.DEFAULT_GAS || 600000),
        gasMarginX10: BigInt(env.GAS_MARGIN_X10 || 30),
        harvestThreshold: BigInt(env.HARVEST_THRESHOLD_NATIVE || 0),
        harvestSlipBps: BigInt(env.HARVEST_SLIP_BPS || 100),
        webhookUrl: env.WEBHOOK_URL || '',
        // ---- E流 onboarding（可选；API_BASE 空 = 关闭，行为与旧版完全一致）----
        apiBase: String(env.API_BASE || '').trim().replace(/\/+$/, ''),
        stakeThreshold: stakeThresholdFromEnv(env), // 押金达标线（wei；e2e 口径 200 native）
    };
}

// 源链 rpc/confirmations 读取（vars 优先；onboarding 的 spoke 侧调用同用此口径——
// chainIndex 维度的 RPC_URL_<idx>/SRC_CHAINS[idx] 覆盖 API 行 rpc）
function srcChainsRpc(env, chainIndex) {
    return env[`RPC_URL_${chainIndex}`]
        || JSON.parse(env.SRC_CHAINS || '{}')[String(chainIndex)]?.rpc
        || null;
}

function srcChainsConf(env, chainIndex) {
    return JSON.parse(env.SRC_CHAINS || '{}')[String(chainIndex)]?.confirmations ?? 3;
}
export { srcChainsRpc, srcChainsConf };

// ---------------- 运行时派生层（E流） ----------------
// 从 D1 onboard(status='active') 档案 + hub ChainRegistry 枚举拼装 vars 之外的
// CHANNELS/OUT_CHANNELS/SRC_CHAINS 并并入 cfg（原地追加，relay.js 消费形状不变）。
// vars 永远优先：同 chainIndex 的 vars 条目存在时派生条目丢弃；ChainRegistry 枚举
// 可用时还兼校准——链被 merge/停用则派生条目摘除（vars 条目不受影响）。
export async function deriveTopology(env, cfg, db) {
    const summary = { onboardRows: 0, channels: 0, outChannels: 0, skipped: 0 };
    if (!db || !cfg.hub.rpcUrl || !cfg.hub.stplBridge) return summary;
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
        if (!varsHasChannel && detail.vault && detail.stplToken) {
            cfg.channels.push({
                chainIndex: idx,
                srcToken: detail.srcToken ?? ZERO_ADDR, // 申请制链入向 native：srcToken=address(0)
                stplToken: detail.stplToken,
                srcDecimals: detail.srcDecimals ?? 18,
                vault: detail.vault,
                covered: detail.covered ?? true, // 第三方链默认开 gas 覆盖预检
            });
            summary.channels++;
        }
        const varsHasOut = cfg.outChannels.some((c) => String(c.chainIndex) === idx);
        if (!varsHasOut && detail.outVault && detail.outToken) {
            cfg.outChannels.push({
                chainIndex: idx,
                vault: detail.outVault,
                token: detail.outToken,
                covered: detail.covered ?? true,
                router: detail.router || null,
            });
            summary.outChannels++;
        }
        if (!cfg.srcChains[idx]) {
            cfg.srcChains[idx] = {
                rpcUrl: srcChainsRpc(env, idx) || registryChains?.[idx]?.rpc || detail.rpc || null,
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
        const regRaw = await callRaw(cfg.hub.rpcUrl, cfg.hub.stplBridge,
            encodeFunctionData({ abi: stplBridgeAbi, functionName: 'registry' }));
        const registryAddr = decodeFunctionResult({ abi: stplBridgeAbi, functionName: 'registry', data: regRaw });
        if (!registryAddr || registryAddr === ZERO_ADDR) return null;
        const n = decodeFunctionResult({
            abi: registryAbi, functionName: 'nextIndex',
            data: await callRaw(cfg.hub.rpcUrl, registryAddr,
                encodeFunctionData({ abi: registryAbi, functionName: 'nextIndex' })),
        });
        const map = {};
        for (let i = 1n; i < n; i++) {
            const r = decodeFunctionResult({
                abi: registryAbi, functionName: 'resolve',
                data: await callRaw(cfg.hub.rpcUrl, registryAddr,
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

// 押金达标线：native 个数（e2e 口径 200），非数字/非正回落默认（vars 只出字符串，护栏必须有）
function stakeThresholdFromEnv(env) {
    const fallback = 200n * 10n ** 18n;
    try {
        const v = parseEther(String(env.STAKE_THRESHOLD ?? '200'));
        return v > 0n ? v : fallback;
    } catch {
        return fallback;
    }
}

// 精度换算：源币 → 18 位映射币（无损放大，仅在 srcDecimals ≤ 18 时无损；恒为放大方向）
export const to18 = (amount, srcDecimals) => amount * 10n ** BigInt(18 - srcDecimals);
// 18 位映射币 → 源币（floor，尾差留在 Vault 池内——池只多不少）
export const from18 = (amount, srcDecimals) => amount / 10n ** BigInt(18 - srcDecimals);
