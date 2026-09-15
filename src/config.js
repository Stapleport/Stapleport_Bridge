// 配置装载：vars（JSON 字符串）+ registry.json 为底，env 覆盖。
// registry.json 由 scripts/sync-registry.mjs 从 Stapleport_hardhat/deployments/all.json 同步。
import registry from '../registry.json' with { type: 'json' };

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

    // 源链清单：chainIndex → { rpcUrl, confirmations }（通道按 chainIndex 归并）
    const srcChains = {};
    for (const c of channels) {
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
        srcChains,
        relayerAddress: null, // worker.js 里由 key 派生后回填
        dryRun: String(env.DRY_RUN || 'false') === 'true',
        lockMs: Number(env.TICK_LOCK_SECONDS || 55) * 1000,
        maxAttempts: Number(env.MAX_ATTEMPTS || 10),
        defaultGas: BigInt(env.DEFAULT_GAS || 600000),
        gasMarginX10: BigInt(env.GAS_MARGIN_X10 || 30),
        harvestThreshold: BigInt(env.HARVEST_THRESHOLD_NATIVE || 0),
        harvestSlipBps: BigInt(env.HARVEST_SLIP_BPS || 100),
        webhookUrl: env.WEBHOOK_URL || '',
    };
}

function srcChainsRpc(env, chainIndex) {
    return env[`RPC_URL_${chainIndex}`]
        || JSON.parse(env.SRC_CHAINS || '{}')[String(chainIndex)]?.rpc
        || null;
}

function srcChainsConf(env, chainIndex) {
    return JSON.parse(env.SRC_CHAINS || '{}')[String(chainIndex)]?.confirmations ?? 3;
}

// 精度换算：源币 → 18 位映射币（无损放大，仅在 srcDecimals ≤ 18 时无损；恒为放大方向）
export const to18 = (amount, srcDecimals) => amount * 10n ** BigInt(18 - srcDecimals);
// 18 位映射币 → 源币（floor，尾差留在 Vault 池内——池只多不少）
export const from18 = (amount, srcDecimals) => amount / 10n ** BigInt(18 - srcDecimals);
