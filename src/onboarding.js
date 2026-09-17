// E流：relayer 自动 onboarding——申请制 spoke 链（API /v1/chains?project=bridge）的
// hub 注册 → spoke chainIndex 后配 → hub 开通道 → 押金人工门 → active 的状态机执行端。
//
// 状态持久化在 D1 onboard 表（migrations/0002_onboard.sql），status = 当前该执行的动作：
//   registered → indexed → channeled → awaiting_stake → active
// 每步都以链上状态为先决条件重读（注册查 lookupByChainId、后配查 chainIndex()、
// 开通道查 getChannel/getOutChannel、押金查 boundValueOf），广播后不等回执——
// 下一轮重读自然对账，全链路幂等；失败保留状态，下轮 cron 重试。
// 押金（StakePool.stakeNative+bind）是资金动作，本模块绝不签：不达标停在 awaiting_stake 告警。
// cron 并发防重入：D1 行 INSERT OR IGNORE + 状态 CAS（store.setOnboardStatus）+
// 单 tick 内 fresh 集合防同步重复广播（跨 isolate 撞车由合约层幂等兜底）。
import { encodeFunctionData, decodeFunctionResult } from 'viem';
import { registryAbi, stplBridgeAbi, vaultAbi, stakePoolAbi } from './lib/abi.js';
import { callRaw } from './lib/rpc.js';
import { sendTx } from './lib/tx.js';
import {
    ensureOnboardRow, setOnboardStatus, setOnboardIndex, setOnboardDetail, listOnboard,
} from './lib/store.js';
import { channelKeyOf, outKeyOf } from './relay.js';
import { srcChainsRpc } from './config.js';

// 入向通道 srcToken=address(0)：申请制链由 BridgeBatchDeployer 出三件套
// （BridgeVault/OutVault/OutToken），没有第三方 ERC20——入向锁的是链 native，
// native 入向通道在合约层不存在：入向通道键 = (chainIndex, srcToken) 挂 ERC20
// （BridgeVault.deposit 只收 ERC20，_validateInit 拒绝 srcToken=0），由接入方按
// token 需求另行开启（手工/将来 API 参数化）。本模块的自动化基线 = 仅出向
// native 通道（outKey = (chainIndex, address(0))，与出向键空间同构）。
export const NATIVE_SRC_TOKEN = '0x0000000000000000000000000000000000000000';

// 入向通道费率默认口径（留作将来按 ERC20 token 自动开入向通道用；e2e 同款：
// Freemium + freeQuota 100 + 10/10/10 bps + coverage 5000 + refPrice 1 native）
const CHANNEL_DEFAULTS = {
    gasPolicy: 1,
    freeQuota: 100n,
    protocolBps: 10n,
    tipBps: 10n,
    thickBps: 10n,
    coverageBps: 5000n,
    refPriceNative: 10n ** 18n,
};
const OUT_CHANNEL_DEFAULTS = { protocolBps: 10n, tipBps: 10n, releaseBps: 10n, coverageBps: 5000n };

// rpc 规范化（与 ChainRegistry._normalize 同构：转小写 + 去尾 '/'；空串由调用方拦）
export const normalizeRpc = (s) => String(s ?? '').trim().toLowerCase().replace(/\/+$/, '');

// ---------------- tick 入口 ----------------

export async function onboardingTick(env, cfg, wallet, db) {
    if (!cfg.apiBase) return; // 未配 API_BASE：onboarding 关闭，vars 通道照常中继
    if (!cfg.hub.rpcUrl || !cfg.hub.stplBridge) return;

    let rows;
    try {
        rows = await fetchBridgeChains(cfg.apiBase);
    } catch (e) {
        console.log(`[bridge] onboarding: API 拉取失败（不影响中继）：${errLine(e)}`);
        return;
    }
    // 注册表地址整 tick 缓存（每链/每步都免一次 registry() 读）
    cfg._registryAddress = await registryAddress(cfg);
    for (const row of rows) {
        try {
            await onboardChain(env, cfg, wallet, db, row);
        } catch (e) {
            console.log(`[bridge] onboarding chain ${row?.chain_id} 异常（保留状态下次重试）：${errLine(e)}`);
        }
    }
}

// API：GET <API_BASE>/v1/chains?project=bridge（响应形状对齐 Web_kit rowToChain 的行结构）
async function fetchBridgeChains(apiBase) {
    const res = await fetch(`${apiBase}/v1/chains?project=bridge`, {
        headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json?.success === false) throw new Error(String(json?.error ?? 'api error'));
    return (json?.chains ?? []).filter((r) => r?.status === 'active');
}

// 单链状态机：限步推进（每步落账为链上读为准；未回执时停当步，下轮续推）。
// 限 8 步：全链路 4 个状态步 + 广播后同 tick 重读确认（模拟链快出块/测试桩即时落账时
// 单 tick 即可走完）；生产链真实出块节奏下每步广播后重读未翻即停，开销封顶。
async function onboardChain(env, cfg, wallet, db, apiRow) {
    const chainId = Number(apiRow.chain_id);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) return;
    const fresh = new Set(); // 本 tick 内已广播的（链,步）键：防同 tick 重复发同一笔
    for (let guard = 0; guard < 8; guard++) {
        const rec = await ensureOnboardRow(db, chainId);
        const status = rec?.status ?? 'registered';
        if (status === 'active') return;
        const progressed = await stepOnboard(env, cfg, wallet, db, apiRow, chainId, status, rec, fresh);
        if (!progressed) return;
    }
}

async function stepOnboard(env, cfg, wallet, db, apiRow, chainId, status, rec, fresh) {
    switch (status) {
        case 'registered': return stepRegister(env, cfg, wallet, db, apiRow, chainId, fresh);
        case 'indexed': return stepIndexVaults(env, cfg, wallet, db, apiRow, chainId, rec, fresh);
        case 'channeled': return stepOpenChannels(env, cfg, wallet, db, apiRow, chainId, rec, fresh);
        case 'awaiting_stake': return stepAwaitStake(env, cfg, wallet, db, apiRow, chainId, rec);
        default: return false;
    }
}

// ---------------- a. registered：hub ChainRegistry 幂等注册 ----------------

async function stepRegister(env, cfg, wallet, db, apiRow, chainId, fresh) {
    const regAddr = cfg._registryAddress;
    if (!regAddr) {
        console.log('[bridge] onboarding: 拿不到 ChainRegistry 地址（registry()=0？），跳过本轮');
        return false;
    }
    const norm = normalizeRpc(apiRow.rpc);
    if (!norm) {
        console.warn(`[bridge] onboarding ${chainId}: API 行 rpc 为空，无法注册`);
        return false;
    }
    // ① 复用：lookupByChainId → 逐个 resolve 比对规范化 rpc（命中已有索引则不重注）
    const idxs = await readChain(cfg.hub.rpcUrl, regAddr, registryAbi, 'lookupByChainId', [BigInt(chainId)]);
    for (const i of idxs ?? []) {
        const r = await readChain(cfg.hub.rpcUrl, regAddr, registryAbi, 'resolve', [i]);
        const finalIdx = Array.isArray(r) ? r[0] : r.finalIdx;
        const chain = Array.isArray(r) ? r[1] : r.chain;
        if (normalizeRpc(chain?.rpc) !== norm) continue;
        if (!chain?.active) {
            console.warn(`[bridge] onboarding ${chainId}: 索引 ${finalIdx} rpc 命中但已被停用/合并，等桥方处理`);
            return false;
        }
        await persistBaseDetail(db, chainId, apiRow); // spoke 合约地址等档案（后续步/派生层取用）
        await setOnboardIndex(db, chainId, finalIdx.toString());
        if (await setOnboardStatus(db, chainId, 'registered', 'indexed')) {
            console.log(`[bridge] onboarding ${chainId}: 复用 ChainRegistry 索引 ${finalIdx}（→ indexed）`);
        }
        return true;
    }
    // ② 注册（并发下他人已落账 → revert "chain+rpc already registered" → 下轮重查复用）
    const key = `registerChain:${chainId}`;
    if (fresh.has(key)) return false;
    fresh.add(key);
    await sendTx(cfg.hub.rpcUrl, wallet, {
        to: regAddr,
        data: encodeFunctionData({ abi: registryAbi, functionName: 'registerChain', args: [BigInt(chainId), String(apiRow.rpc)] }),
    }, cfg);
    return true; // 广播未回执：留在本步，同 tick 重查命中即推进（未命中则下轮）
}

// ---------------- b. indexed：spoke BridgeVault/OutVault setChainIndex 后配 ----------------

async function stepIndexVaults(env, cfg, wallet, db, apiRow, chainId, rec, fresh) {
    const expected = BigInt(rec.chain_index ?? 0);
    if (expected === 0n) return false;
    const detail = parseDetail(rec);
    const vault = detail.vault; // API contracts.BridgeVault
    const outVault = detail.outVault; // API contracts.OutVault
    if (!vault) {
        console.warn(`[bridge] onboarding ${chainId}: API contracts 缺 BridgeVault，无法后配`);
        return false;
    }
    const rpcUrl = srcChainsRpc(env, rec.chain_index) || apiRow.rpc; // vars 覆盖优先，回落 API 行 rpc
    if (!rpcUrl) {
        console.warn(`[bridge] onboarding ${chainId}: 无可用 spoke rpc`);
        return false;
    }
    const mainOk = await ensureIndexed(env, cfg, wallet, rpcUrl, vault, expected, 'BridgeVault', chainId, fresh);
    let outOk = true;
    if (outVault) {
        outOk = await ensureIndexed(env, cfg, wallet, rpcUrl, outVault, expected, 'OutVault', chainId, fresh);
    } else {
        console.warn(`[bridge] onboarding ${chainId}: API contracts 缺 OutVault，仅后配 BridgeVault`);
    }
    if (mainOk && outOk) {
        if (await setOnboardStatus(db, chainId, 'indexed', 'channeled')) {
            console.log(`[bridge] onboarding ${chainId}: spoke chainIndex 后配完成（→ channeled）`);
        }
        return true;
    }
    return false; // 有 tx 未回执或链上值不符：停当步
}

async function ensureIndexed(env, cfg, wallet, rpcUrl, addr, expected, label, chainId, fresh) {
    const cur = await readChain(rpcUrl, addr, vaultAbi, 'chainIndex');
    if (cur === expected) return true;
    if (cur !== 0n) {
        console.warn(`[bridge] onboarding ${chainId}: ${label}.chainIndex 已锁定为 ${cur} ≠ 期望 ${expected}，等人工核对`);
        return false;
    }
    const key = `setChainIndex:${addr.toLowerCase()}`;
    if (fresh.has(key)) return false;
    fresh.add(key);
    // setChainIndex 在 BridgeVault/OutVault 上签名一致（viem 择一编码，selector 同）
    await sendTx(rpcUrl, wallet, {
        to: addr,
        data: encodeFunctionData({ abi: vaultAbi, functionName: 'setChainIndex', args: [expected] }),
    }, cfg);
    return true; // 已广播，重读确认放到下一轮循环/tick
}

// ---------------- c. channeled：hub openOutChannel（出向 native 通道） ----------------
// 入向通道挂 ERC20（srcToken≠0），按 token 需求另行开启——自动化基线仅出向。

async function stepOpenChannels(env, cfg, wallet, db, apiRow, chainId, rec, fresh) {
    const expected = BigInt(rec.chain_index ?? 0);
    if (expected === 0n) return false;
    const detail = parseDetail(rec);
    const hubRpc = cfg.hub.rpcUrl;

    if (!detail.outVault || !detail.outToken) {
        console.warn(`[bridge] onboarding ${chainId}: API contracts 缺 OutVault/OutToken，无法开出向通道，停 channeled`);
        return false;
    }

    // 出向（hub native → spoke stplN）：outKey = (chainIndex, address(0))
    const outKey = outKeyOf(expected);
    const oc = arrOr(
        await readChain(hubRpc, cfg.hub.stplBridge, stplBridgeAbi, 'getOutChannel', [outKey]),
        ['chainIndex', 'authority'],
    );
    const outAuthority = oc?.authority ?? null;
    if (!outAuthority || outAuthority === '0x0000000000000000000000000000000000000000') {
        const key = 'openOutChannel:' + outKey;
        if (fresh.has(key)) return false;
        fresh.add(key);
        try {
            await sendTx(hubRpc, wallet, {
                to: cfg.hub.stplBridge,
                data: encodeFunctionData({
                    abi: stplBridgeAbi, functionName: 'openOutChannel',
                    args: [{ chainIndex: expected, authority: wallet.address, ...OUT_CHANNEL_DEFAULTS }],
                }),
            }, cfg);
        } catch (e) {
            if (!/out channel exists|channel exists/i.test(String(e.message))) throw e;
            console.log(`[bridge] onboarding ${chainId}: openOutChannel revert=已存在，等重读确认`);
        }
        return false; // 等重读确认（未 mined 则停当步下轮再来）
    }

    // 出向通道就绪：档案回填 srcDecimals/covered → awaiting_stake（押金人工门）
    detail.srcDecimals = Number(apiRow.native_decimals ?? 18);
    detail.covered = true; // 申请制链一律按第三方链开 gas 覆盖预检
    await setOnboardDetail(db, chainId, detail);
    if (await setOnboardStatus(db, chainId, 'channeled', 'awaiting_stake')) {
        console.log(`[bridge] onboarding ${chainId}: 出向通道就绪 outKey=${outKey}（→ awaiting_stake，等人工押金）`);
    }
    return true;
}

// ---------------- d. awaiting_stake：押金人工门（绝不自动质押） ----------------

async function stepAwaitStake(env, cfg, wallet, db, apiRow, chainId, rec) {
    if (!cfg.hub.stakePool) {
        console.warn(`[bridge] onboarding ${chainId}: 未配 STAKEPOOL，无法核押，停 awaiting_stake`);
        return false;
    }
    const expected = BigInt(rec.chain_index ?? 0);
    const detail = parseDetail(rec);
    const threshold = cfg.stakeThreshold;
    const hubRpc = cfg.hub.rpcUrl;

    // 只核实际开出的出向通道（入向按 token 另行开启，不在自动化基线内）
    if (!detail.outVault || !detail.outToken) {
        console.warn(`[bridge] onboarding ${chainId}: 无出向通道可核押，停 awaiting_stake`);
        return false;
    }
    const outKey = outKeyOf(expected);
    const boundOut = await readChain(hubRpc, cfg.hub.stakePool, stakePoolAbi, 'boundValueOf', [outKey]);
    if (boundOut < threshold) {
        console.warn(`[bridge] onboarding ${chainId}: 押金未达标（出向 ${boundOut} < ${threshold} wei），停在 awaiting_stake——押金须人工 StakePool.stakeNative+bind(outKey)，绝不自动质押`);
        return false;
    }
    if (await setOnboardStatus(db, chainId, 'awaiting_stake', 'active')) {
        console.log(`[bridge] onboarding ${chainId}: 押金达标，链 active（拓扑交派生层并入运行时 config）`);
    }
    return true;
}

// ---------------- /health 摘要 ----------------

export async function onboardSummary(db, cfg) {
    const rows = await listOnboard(db);
    return {
        apiBase: cfg.apiBase || null,
        stakeThreshold: cfg.stakeThreshold.toString(),
        chains: rows.map((r) => ({
            chainId: r.chain_id,
            status: r.status,
            chainIndex: r.chain_index ?? null,
            updatedAt: r.updated_at,
        })),
    };
}

// ---------------- 小件 ----------------

// eth_call 只读 + viem 解码（单返回值 viem 直接给值本身，双返回值/结构体见各调用处兼容）
async function readChain(rpcUrl, to, abi, functionName, args = []) {
    const raw = await callRaw(rpcUrl, to, encodeFunctionData({ abi, functionName, args }));
    return decodeFunctionResult({ abi, functionName, data: raw });
}

async function registryAddress(cfg) {
    if (cfg._registryAddress) return cfg._registryAddress;
    try {
        const addr = await readChain(cfg.hub.rpcUrl, cfg.hub.stplBridge, stplBridgeAbi, 'registry');
        if (!addr || addr === '0x0000000000000000000000000000000000000000') return null;
        return addr;
    } catch {
        return null;
    }
}

function parseDetail(rec) {
    try { return JSON.parse(rec?.detail || '{}') ?? {}; } catch { return {}; }
}

// 基础档案落库（registered 步）：spoke 三件套地址 + rpc/名字——indexed/channeled 步
// 与 config.js 派生层都从这里取
async function persistBaseDetail(db, chainId, apiRow) {
    await setOnboardDetail(db, chainId, {
        rpc: String(apiRow.rpc || ''),
        name: String(apiRow.name || ''),
        vault: apiRow.contracts?.BridgeVault ?? null,
        outVault: apiRow.contracts?.OutVault ?? null,
        outToken: apiRow.contracts?.OutToken ?? null,
    });
}

// stplN 符号：API native_symbol 优先，回落链名清洗；限 8 位（stpl 前缀后总长 ≤ 12）
function symbolOf(apiRow, chainId) {
    const raw = String(apiRow.native_symbol || apiRow.name || `C${chainId}`);
    const sym = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
    return sym || 'NATIVE';
}

// viem 解码防御：结构体返回对象/数组双形态归一为对象（keys 按该结构体字段序给）
function arrOr(v, keys) {
    if (!Array.isArray(v)) return v;
    const o = {};
    keys.forEach((k, i) => { o[k] = v[i]; });
    return o;
}

function errLine(e) {
    return String(e?.message ?? e).slice(0, 160);
}
