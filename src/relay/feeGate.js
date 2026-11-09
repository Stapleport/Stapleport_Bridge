// 预付 gas 费率面（bridge-fee-design §3 / §3.4）：域描述、现读现估、闸门决策。
import { vaultAbi, spBridgeAbi, outVaultAbi } from '../lib/abi.js';
import { callRaw } from '../lib/rpc.js';
import {
    fetchGas, oracleFacts, admitCheck, sweepCheck, estimateLegAWei, readPadFloor, readFees, readLegB,
} from '../lib/fee.js';
import { setFeeState, bumpFeeAttempts } from '../lib/store.js';

// ================= 预付 gas 费率面（bridge-fee-design §3 / §3.4）=================
// 费率乘数/常数单一出处 = kit（经 lib/fee.js 再导出）；本文件不出现 ×10/×5 字面量。
// 四向 dir：1=deposit/executeMint、2=requestBurn/executeRelease、3=lockOut/executeOutMint、
// 4=requestOutBurn/executeOutRelease。费 escrow 落链见设计稿 §1.2。

// 费率域描述（escrow 落链/键 + A/B 链口径）。aRpc/bRpc 供 oracle 归一，aChainId/bChainId 取
// evm chainId（缺失 → null → oracle 落 FALLBACK_PRICE）。stability hint：hub=USDSP（稳定）。
function feeDomain(cfg, dir, ch, erc20) {
    const hub = cfg.hub;
    const src = cfg.srcChains[String(ch?.chainIndex)];
    if (dir === 1) {
        return {
            rpcUrl: ch.rpcUrl ?? src?.rpcUrl, to: ch.vault, abi: vaultAbi,
            padFn: 'padFloorDir1', feesFn: 'depositFees', legBFn: 'legBDir1',
            aChainId: ch.evmChainId ?? null, aStable: false,
            bChainId: hub.chainId, bStable: true,
        };
    }
    if (dir === 2) {
        return {
            rpcUrl: hub.rpcUrl, to: hub.spBridge, abi: spBridgeAbi,
            padFn: 'padFloorDir2', feesFn: 'burnFees', legBFn: 'legBDir2',
            aChainId: hub.chainId, aStable: true,
            bChainId: ch?.evmChainId ?? null, bStable: false,
        };
    }
    if (dir === 3) {
        return {
            rpcUrl: hub.rpcUrl, to: hub.spBridge, abi: spBridgeAbi,
            padFn: 'padFloorDir3', feesFn: erc20 ? 'outLockFeesErc20' : 'outLockFees', legBFn: 'legBDir3',
            aChainId: hub.chainId, aStable: true,
            bChainId: ch?.evmChainId ?? null, bStable: false,
        };
    }
    return {
        rpcUrl: ch?.rpcUrl ?? src?.rpcUrl, to: ch?.vault, abi: outVaultAbi,
        padFn: 'padFloorDir4', feesFn: 'outBurnFees', legBFn: 'legBDir4',
        aChainId: ch?.evmChainId ?? null, aStable: false,
        bChainId: hub.chainId, bStable: true,
    };
}

// 现读链上 Fees/padFloor + oracle 重估（每次调用现估，无跨 tick 缓存）。读失败 → null（放行现役行为）。
async function evaluateFee(env, cfg, dir, ch, erc20, seq) {
    const dom = feeDomain(cfg, dir, ch, erc20);
    if (!dom.rpcUrl || !dom.to) return null;
    try {
        const fees = await readFees(callRaw, dom.rpcUrl, dom.to, dom.abi, dom.feesFn, [seq]);
        if (fees.state !== 0) return { terminal: true, fees }; // 非 Escrowed：已退款/已领奖（终态）
        const [padFloorWei, legBWei, gasA, gasB] = await Promise.all([
            readPadFloor(callRaw, dom.rpcUrl, dom.to, dom.abi, dom.padFn),
            readLegB(callRaw, dom.rpcUrl, dom.to, dom.abi, dom.legBFn),
            fetchGas(cfg.oracleBase, dom.aChainId),
            fetchGas(cfg.oracleBase, dom.bChainId),
        ]);
        const a = oracleFacts(gasA, { stableHint: dom.aStable });
        const b = oracleFacts(gasB, { stableHint: dom.bStable });
        const paidWei = fees.pad + fees.reward;
        const adm = admitCheck({
            dir, paidWei, padFloorWei,
            gasPriceWeiB: b.gasPriceWei, priceBScaled: b.priceScaled, priceAScaled: a.priceScaled,
        });
        const legAWei = estimateLegAWei({ padFloorWei, legBWei });
        const sw = sweepCheck({ paidWei, legAWei, legBWei });
        return {
            fees, padFloorWei, legBWei, paidWei,
            admit: adm.admit, rewardWei: adm.rewardWei, sweep: sw.sweep, costWei: sw.costWei,
        };
    } catch (e) {
        console.log(`[bridge] fee 评估异常 dir=${dir} seq=${seq}：${String(e.message).slice(0, 120)}（放行现役行为）`);
        return null;
    }
}

// 费率闸门：读现状 + 现估 → 决策。返回 action ∈
//   proceed（准入达标 / 无法评估，放行广播正常执行腿）
//   insufficient（未达标：置 fee_state='insufficient'，不广播不计 attempts）
//   adjudicate（过 deadline+缓冲：置 'admit'，广播过期裁决腿——复用同执行编码，合约过期分支收口）
//   never_sweep（过期且垃圾 paid<两腿成本：置 'never_sweep' 终态，跳过）
//   terminal（Fees state≠Escrowed：已终态）
export async function feeAction(env, cfg, db, { dir, ch, erc20 = false, seq, buyDeadlineSecs, direction, key }) {
    const nowSec = Math.floor(Date.now() / 1000);
    const dl = Number(buyDeadlineSecs ?? 0);
    const pastDeadline = dl > 0 && nowSec > dl + cfg.adjudicateBufferSec;
    const ev = await evaluateFee(env, cfg, dir, ch, erc20, seq);
    if (!ev) return { action: 'proceed' };
    if (ev.terminal) return { action: 'terminal', ev };
    if (pastDeadline) {
        if (!ev.sweep) {
            await setFeeState(db, direction, key, 'never_sweep');
            return { action: 'never_sweep', ev };
        }
        await setFeeState(db, direction, key, 'admit');
        return { action: 'adjudicate', ev };
    }
    if (!ev.admit) {
        await setFeeState(db, direction, key, 'insufficient');
        await bumpFeeAttempts(db, direction, key);
        return { action: 'insufficient', ev };
    }
    await setFeeState(db, direction, key, 'admit');
    return { action: 'proceed', ev };
}
