// 桥用户预付 gas 费率 · relayer 准入模块（设计稿 bridge-fee-design §3.3 / §6）。
//
// 职责：
//   - 费率乘数/常数单一出处 = kit `stapleport-web-kit/bridgefee`（禁本仓重抄 ×10/×5/EXEC_GAS）；
//   - oracle 原料：GET `${oracleBase}/gas?chainId=<id>`（AbortController 4s 超时；失败/超时 → kit
//     FALLBACK_PRICE 保守值）；
//   - 币种归一（§6 实现注①）：kit 收**已归一**入参，B→A 汇率拼装在本模块完成；
//   - 准入判定 admitCheck（每次尝试现估，无跨 tick 缓存——冻结 D1）+ 垃圾兜底 sweepCheck（k=1）。
//
// 纯算术函数不碰 IO（node --test 直测）；IO 读取（oracle fetch / 链上 getter）走显式注入。
// 乘数/常数（×10 奖励 / ×5 准入 / 执行 gas 键 / SP floor / 失败兜底价）一律经 kit 单源——
// 本模块只 import kit 的纯函数与 FALLBACK_PRICE，不重抄任何乘数常数。
import { FALLBACK_PRICE, rewardEstWei, admitOk, sweepCostFloorWei } from 'stapleport-web-kit/bridgefee';

const WEI18 = 10n ** 18n;
const GWEI = 10n ** 9n;
const ORACLE_TIMEOUT_MS = 4000;

// 人类数值（整数/小数/字符串）→ 定标 BigInt。bigint 视为已按同一 decimals 的整数口径吗？
// 口径：一律把入参当「人类读数」按 decimals 定标（如 1.5 gwei → 1.5e9 wei；600 USD → 600e18）。
// 小数位超过 decimals 则截断（保守向零）。
function toScaled(v, decimals) {
    const s = String(v ?? '0').trim();
    if (!s || s === '0') return 0n;
    const neg = s.startsWith('-');
    const body = neg ? s.slice(1) : s;
    let out;
    if (!body.includes('.')) {
        out = BigInt(body) * 10n ** BigInt(decimals);
    } else {
        const [i, f = ''] = body.split('.');
        const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
        out = BigInt((i || '0') + frac);
    }
    return neg ? -out : out;
}

// gasPriceGwei（人类读数）→ wei
export const gweiToWei = (v) => toScaled(v, 9);

// 原生币 USD 价（人类读数）→ 1e18 定标 BigInt（供跨链比率归一）
export const priceToScaled = (v) => toScaled(v, 18);

// ---- oracle 原料 ----

// GET ${oracleBase}/gas?chainId=<id>；超时/非 2xx/解析失败 → null（caller 落 FALLBACK_PRICE）。
export async function fetchGas(oracleBase, chainId, { fetchImpl = globalThis.fetch, timeoutMs = ORACLE_TIMEOUT_MS } = {}) {
    if (!oracleBase || chainId == null || chainId === '') return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetchImpl(`${oracleBase}/gas?chainId=${encodeURIComponent(String(chainId))}`, { signal: ctrl.signal });
        if (!res || !res.ok) return null;
        const body = await res.json();
        return body && typeof body === 'object' ? body : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// oracle 失联/字段缺失时的 gasPrice 缺省 = 10 gwei（保守抬高准入门槛：失联期 op 进不了门、
// 等 oracle 恢复后在 admitWindow 内重试——admitCheck 每次尝试重估故不误杀）。与前端 L3 线
// 同名同值（FALLBACK_GAS_PRICE_WEI=10n**10n）。kit §6 冻结接口无此键，不进 kit。
export const FALLBACK_GAS_PRICE_WEI = 10n ** 10n;

// oracle 响应 → { gasPriceWei, priceScaled }；失败（null）或 gwei 字段缺失落 FALLBACK 保守值。
// stableHint=true（SPUSD 等锚定币侧）→ 价固定 1 USD；否则用 oracle nativePriceUsdt / FALLBACK bnbUsdt。
export function oracleFacts(raw, { stableHint = false } = {}) {
    const fallbackPrice = stableHint ? 1 : FALLBACK_PRICE.bnbUsdt;
    if (!raw) {
        return { gasPriceWei: FALLBACK_GAS_PRICE_WEI, priceScaled: priceToScaled(fallbackPrice) };
    }
    const gwei = raw.gasPriceGwei ?? raw.gasPrice;
    const gasPriceWei = gwei == null ? FALLBACK_GAS_PRICE_WEI : gweiToWei(gwei);
    const priceUsdt = raw.nativePriceUsdt ?? fallbackPrice;
    return { gasPriceWei, priceScaled: priceToScaled(priceUsdt) };
}

// ---- 归一 + 判定（纯算术）----
//
// kit 量纲契约（追派三，主会话裁定；kit 源码注释互证）：
//   kit rewardEstWei 输出 = A 链原生币奖励 wei = 执行 gas 键[dir] × gasPriceWei × nativePriceUsdt
//     × 奖励倍数 / 1e18（乘数名与值见 kit `stapleport-web-kit/bridgefee`，本模块不重抄）。
//   入参定标：gasPriceWei = **B 链 gasPrice 原始 wei**；
//             nativePriceUsdt = **(B 链原生币 U 价 / A 链原生币 U 价) × 1e18 的整数**
//   （换算比 1e18 定标；kit 测试向量只锁算术，量纲以本裁定为准）。
// oracle /gas 响应向量实读钉值（Stapleport_Oracle/test/gas.test.mjs + src/lib/gas.js:133-136）：
//   gasPriceGwei = number（toFixed(6)）；nativePriceUsdt = number（toFixed(2)，如 600 / 1 / 2505）。
// 折算全 BigInt 域；除法一律向上取整（成本侧保守偏高）。

// 向上取整除法（正数域）：ceil(n/d)。d≤0 时按 1 兜底。
const ceilDiv = (n, d) => (d > 0n ? (n + d - 1n) / d : n);

// B 链执行成本 → A 链原生币计奖励（§6 注①）：kit 收已归一入参。
// gasPriceWeiB = B 链 gasPrice 原始 wei；price*Scaled = 各链原生币 USD 价 1e18 定标。
export function normalizedRewardWei({ dir, gasPriceWeiB, priceBScaled, priceAScaled }) {
    const a = priceAScaled > 0n ? priceAScaled : WEI18; // 防御：A 价缺失时按 1:1
    const normPrice = ceilDiv(priceBScaled * WEI18, a); // = (priceB/priceA) × 1e18（向上取整）
    return rewardEstWei({ dir, gasPriceWei: gasPriceWeiB, nativePriceUsdt: normPrice });
}

// 准入判定：paid ≥ 重估奖励 × 5 + padFloor（kit admitOk）。返回 { admit, rewardWei }。
export function admitCheck({ dir, paidWei, padFloorWei, gasPriceWeiB, priceBScaled, priceAScaled }) {
    const rewardWei = normalizedRewardWei({ dir, gasPriceWeiB, priceBScaled, priceAScaled });
    return { admit: admitOk({ paidWei, rewardWei, padFloorWei }), rewardWei };
}

// A 腿估算（垃圾判据用）：padFloor = max(A腿,B腿)×2；保守取 A 腿上界 = max(padFloor/2, legB)。
export function estimateLegAWei({ padFloorWei, legBWei }) {
    const maxLeg = BigInt(padFloorWei) / 2n;
    return maxLeg > BigInt(legBWei) ? maxLeg : BigInt(legBWei);
}

// 垃圾兜底判据（k=1）：paid < 重估裁决两腿成本 → never_sweep（不裁决不退款，代码明文分类）。
export function sweepCheck({ paidWei, legAWei, legBWei }) {
    const costWei = sweepCostFloorWei({ legAWei, legBWei });
    return { sweep: BigInt(paidWei) >= costWei, costWei };
}

// ---- 链上读取 ----

// 读 padFloorDirN()（链上强制下限 view，D6 前端/worker 直读正典源）。
export async function readPadFloor(callRaw, rpcUrl, to, abi, fn) {
    const { encodeFunctionData, decodeFunctionResult } = await import('viem');
    const raw = await callRaw(rpcUrl, to, encodeFunctionData({ abi, functionName: fn }));
    return decodeFunctionResult({ abi, functionName: fn, data: raw });
}

// 读 Fees getter（dir1 depositFees / dir2 burnFees / dir3 outLockFees(|Erc20) / dir4 outBurnFees）。
// 返回 { pad:bigint, reward:bigint, payer, state:number }。state 枚举：0=Escrowed 1=Refunded 2=Claimed。
export async function readFees(callRaw, rpcUrl, to, abi, fn, args) {
    const { encodeFunctionData, decodeFunctionResult } = await import('viem');
    const raw = await callRaw(rpcUrl, to, encodeFunctionData({ abi, functionName: fn, args }));
    const r = decodeFunctionResult({ abi, functionName: fn, data: raw });
    const [pad, reward, payer, state] = Array.isArray(r)
        ? r
        : [r.pad, r.reward, r.payer, r.state];
    return { pad: BigInt(pad), reward: BigInt(reward), payer, state: Number(state) };
}

// 读 legBDirN()（storage 常数，A 原生币计价）。
export async function readLegB(callRaw, rpcUrl, to, abi, fn) {
    const { encodeFunctionData, decodeFunctionResult } = await import('viem');
    const raw = await callRaw(rpcUrl, to, encodeFunctionData({ abi, functionName: fn }));
    return decodeFunctionResult({ abi, functionName: fn, data: raw });
}
