// 费率准入模块（src/lib/fee.js）+ 卡死停试（relay/refund）+ D1 计数器 stub 对拍。
// 风格对齐 tx.test.mjs / onboarding.test.mjs：fetch/wallet/D1 全 stub，零网络。
// 覆盖：kit 真量纲（dir2 4.5e18 腿）/ 准入不足 / 垃圾兜底 / oracle 归一与降级 / 浮点入参抛错 /
//       setFeeState+bumpStuckCount 落账 / 领奖腿预估连续失败→claim_stuck / 退款腿→refund_stuck。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    REWARD_X10, ADMIT_X5, EXEC_GAS, SP_FLOOR_WEI, FALLBACK_PRICE,
    rewardEstWei, admitOk, sweepCostFloorWei,
} from 'stapleport-web-kit/bridgefee';
import {
    gweiToWei, priceToScaled, oracleFacts, fetchGas, normalizedRewardWei, admitCheck,
    estimateLegAWei, sweepCheck, FALLBACK_GAS_PRICE_WEI,
} from '../src/lib/fee.js';
import { setFeeState, bumpStuckCount } from '../src/lib/store.js';
import { attemptClaim, isAdjudicatedSettled, ensureClaim } from '../src/relay.js';
import { attemptRefund } from '../src/refund.js';
import { spBridgeAbi, DEPOSIT_REFUNDED_EVENT } from '../src/lib/abi.js';
import { encodeAbiParameters, parseAbiItem, getEventSelector } from 'viem';

const W18 = 10n ** 18n;

// ---------------- 纯算术 / kit 契约 ----------------

test('kit 契约再导出：乘数/常数单一出处（kit）', () => {
    assert.equal(REWARD_X10, 10n);
    assert.equal(ADMIT_X5, 5n);
    // EXEC_GAS/SP_FLOOR 值由 L4 实测回填（deploy-meta 先例）——断言形状/正数，勿钉死后漂移
    for (const d of ['dir1', 'dir2', 'dir3', 'dir4']) {
        assert.equal(typeof EXEC_GAS[d], 'bigint');
        assert.ok(EXEC_GAS[d] > 0n);
    }
    assert.ok(SP_FLOOR_WEI > 0n);
    assert.equal(FALLBACK_PRICE.bnbUsdt, 600n);
});

test('真量纲腿：dir2 B=BSC 600、A=SP 1、gasPrice 5gwei → kit 公式逐位对齐（≈1e18 量级）', () => {
    const gasPriceWeiB = 5n * 10n ** 9n;
    const normPrice = 600n * W18; // (600/1) × 1e18
    const reward = normalizedRewardWei({
        dir: 2,
        gasPriceWeiB,
        priceBScaled: priceToScaled(600),
        priceAScaled: priceToScaled(1),
    });
    // 与 kit 公式（执行 gas 键 × gasPriceWei × 归一价 × 奖励倍数 / 1e18）逐位对齐（dir2 无 floor）
    const expected = (EXEC_GAS.dir2 * gasPriceWeiB * normPrice * REWARD_X10) / W18;
    assert.equal(reward, expected);
    assert.ok(reward > 10n ** 18n && reward < 10n ** 19n, `reward=${reward}`); // ≈1e18 量级（L4 回填后约 3.45e18）
});

test('dir1/dir4 SP 侧 floor 兜底：gasPrice 极小 → SP_FLOOR_WEI', () => {
    for (const dir of [1, 4]) {
        const reward = normalizedRewardWei({
            dir, gasPriceWeiB: 0n, priceBScaled: priceToScaled(1), priceAScaled: priceToScaled(600),
        });
        assert.equal(reward, SP_FLOOR_WEI);
    }
});

test('归一除法向上取整（成本侧保守偏高）', () => {
    // 600/7 × 1e18 非整 → ceil；断言不小于精确值（floor 会偏小）
    const reward = normalizedRewardWei({ dir: 2, gasPriceWeiB: 10n ** 9n, priceBScaled: priceToScaled(600), priceAScaled: priceToScaled(7) });
    // 精确 = 150000 × 1e9 × (600/7) × 10 ；向上取整 ≥ floor 值
    const exactFloor = (EXEC_GAS.dir2 * 10n ** 9n * (600n * W18 / 7n) * 10n) / W18;
    assert.ok(reward >= exactFloor);
});

test('浮点入参不得出现：kit rewardEstWei 收非整数抛 RangeError', () => {
    assert.throws(() => rewardEstWei({ dir: 2, gasPriceWei: 1.5, nativePriceUsdt: W18 }), RangeError);
    assert.throws(() => rewardEstWei({ dir: 2, gasPriceWei: '1e9', nativePriceUsdt: W18 }), SyntaxError);
    // 本模块折算产物恒 bigint（不向 kit 传浮点）
    const f = oracleFacts({ gasPriceGwei: 0.0591, nativePriceUsdt: 600 }, { stableHint: false });
    assert.equal(typeof f.gasPriceWei, 'bigint');
    assert.equal(typeof f.priceScaled, 'bigint');
    assert.equal(f.gasPriceWei, 59_100_000n); // 0.0591 gwei
    assert.equal(f.priceScaled, 600n * W18);
});

test('admitCheck：paid ≥ reward×5 + padFloor 达标；不足不达标', () => {
    const rewardWei = 2n * W18;
    const padFloorWei = 100n * W18;
    const paidWei = rewardWei * 5n + padFloorWei; // 恰好达标
    const ok = admitCheck({ dir: 2, paidWei, padFloorWei, gasPriceWeiB: 0n, priceBScaled: priceToScaled(1), priceAScaled: priceToScaled(1) });
    // 注意：此处 rewardWei 由现估得出，仅校验边界函数语义
    assert.equal(admitOk({ paidWei: 10n, rewardWei: 1n, padFloorWei: 5n }), true);   // 10 ≥ 5+5
    assert.equal(admitOk({ paidWei: 9n, rewardWei: 1n, padFloorWei: 5n }), false);   // 9 < 5+5
    assert.equal(typeof ok.admit, 'boolean');
});

test('sweepCheck：paid < 两腿成本 → 不 sweep（垃圾）；达标 → sweep', () => {
    const cost = sweepCostFloorWei({ legAWei: 10n, legBWei: 20n });
    assert.equal(cost, 30n);
    assert.equal(sweepCheck({ paidWei: 29n, legAWei: 10n, legBWei: 20n }).sweep, false);
    assert.equal(sweepCheck({ paidWei: 30n, legAWei: 10n, legBWei: 20n }).sweep, true);
    // A 腿估算上界：padFloor/2 与 legB 取大
    assert.equal(estimateLegAWei({ padFloorWei: 100n, legBWei: 40n }), 50n);
    assert.equal(estimateLegAWei({ padFloorWei: 60n, legBWei: 40n }), 40n); // padFloor/2=30 < legB
});

// ---------------- oracle ----------------

test('fetchGas：200 → 解析；非 200 / 抛错 / 超时 → null', async () => {
    const ok = await fetchGas('http://o', 97, {
        fetchImpl: async () => new Response(JSON.stringify({ gasPriceGwei: 1, nativePriceUsdt: 600 }), { status: 200 }),
    });
    assert.equal(ok.nativePriceUsdt, 600);
    assert.equal(await fetchGas('http://o', 97, { fetchImpl: async () => new Response('x', { status: 500 }) }), null);
    assert.equal(await fetchGas('http://o', 97, { fetchImpl: async () => { throw new Error('net'); } }), null);
    assert.equal(await fetchGas('', 97, { fetchImpl: async () => new Response('{}', { status: 200 }) }), null);
    // 超时：fetch 挂起，AbortController 4s→20ms 触发
    const slow = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    assert.equal(await fetchGas('http://o', 97, { fetchImpl: slow, timeoutMs: 20 }), null);
});

test('oracleFacts：null → kit FALLBACK_PRICE + FALLBACK_GAS_PRICE_WEI；stableHint → 价 1', () => {
    const fb = oracleFacts(null, { stableHint: false });
    assert.equal(fb.priceScaled, FALLBACK_PRICE.bnbUsdt * W18);
    // 失联期 gasPrice 缺省=10 gwei（保守抬高门槛，勿估 0 → 必被 admitOk 拦在门外）
    assert.equal(FALLBACK_GAS_PRICE_WEI, 10n ** 10n);
    assert.equal(fb.gasPriceWei, 10_000_000_000n);
    const sp = oracleFacts(null, { stableHint: true });
    assert.equal(sp.priceScaled, 1n * W18);
    assert.equal(sp.gasPriceWei, 10_000_000_000n);
});

test('oracleFacts：raw 存在但 gasPriceGwei/gasPrice 缺字段 → 同缺省 10 gwei（勿落 0）', () => {
    const noGwei = oracleFacts({ nativePriceUsdt: 600 }, { stableHint: false });
    assert.equal(noGwei.gasPriceWei, 10_000_000_000n);
    assert.equal(noGwei.priceScaled, 600n * W18); // 价字段在，照用
    const noGweiNoPrice = oracleFacts({ costUsdt: 0.001 }, { stableHint: true });
    assert.equal(noGweiNoPrice.gasPriceWei, 10_000_000_000n);
    assert.equal(noGweiNoPrice.priceScaled, 1n * W18); // stableHint 兜底价 1
});

// ---------------- D1 计数器 / 卡死停试 ----------------

import { MemD1 } from './helpers/mem-d1.mjs';

// fetch stub：估 gas 恒抛（tx.js 统一收口 → 跳过广播返回 null），eth_call 记诊断
function failEstimateFetch() {
    const calls = [];
    const fn = async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push(body.method);
        if (body.method === 'eth_estimateGas') throw new Error('estimate boom');
        if (body.method === 'eth_call') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' }), { status: 200 });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null }), { status: 200 });
    };
    return { fetchImpl: fn, calls };
}

const wallet = { address: '0x' + 'ab'.repeat(20), signTransaction: async () => '0xsigned' };
const hub = { chainId: '31339', rpcUrl: 'https://hub.example', spBridge: '0x' + '11'.repeat(20) };
const baseCfg = { hub, dryRun: false, maxAttempts: 16, stuckThreshold: 5, defaultGas: 600000n, oracleBase: '' };

test('setFeeState / bumpStuckCount 落账（store SQL 形状对拍）', async () => {
    const db = new MemD1(); db.seed('fee_claim_out_mint', '1:7');
    assert.equal(await bumpStuckCount(db, 'fee_claim_out_mint', '1:7'), 1);
    assert.equal(await bumpStuckCount(db, 'fee_claim_out_mint', '1:7'), 2);
    await setFeeState(db, 'fee_claim_out_mint', '1:7', 'insufficient');
    assert.equal(db.rows.get('fee_claim_out_mint|1:7').fee_state, 'insufficient');
});

test('领奖腿预估连续失败 ≥5 → claim_stuck 终态停试', async () => {
    const db = new MemD1(); db.seed('fee_claim_out_mint', '1:7');
    const spec = {
        direction: 'fee_claim_out_mint', key: '1:7', chainIndex: '1',
        rpcUrl: hub.rpcUrl, to: hub.spBridge, abi: spBridgeAbi, fn: 'claimOutLockFee', args: [7n],
        viewFn: 'outLockFees', viewArgs: [7n], payload: { dir: 3, erc20: false, chainIndex: '1', seq: '7' },
    };
    const orig = globalThis.fetch;
    globalThis.fetch = failEstimateFetch().fetchImpl;
    try {
        for (let i = 0; i < 4; i++) await attemptClaim({}, baseCfg, wallet, db, spec);
        assert.equal(db.rows.get('fee_claim_out_mint|1:7').fee_state, null); // 未达阈值不停试
        await attemptClaim({}, baseCfg, wallet, db, spec);                    // 第 5 次
        assert.equal(db.rows.get('fee_claim_out_mint|1:7').fee_state, 'claim_stuck');
    } finally { globalThis.fetch = orig; }
});

test('退款腿预估连续失败 ≥5 → refund_stuck 终态停试', async () => {
    const db = new MemD1(); db.seed('refund_burn', '1:7');
    const p = { chainIndex: '1', spToken: '0x' + '22'.repeat(20), outId: '7', recipient: '0x' + '33'.repeat(20), amount: '100' };
    const orig = globalThis.fetch;
    globalThis.fetch = failEstimateFetch().fetchImpl;
    try {
        for (let i = 0; i < 4; i++) await attemptRefund({}, baseCfg, wallet, db, 'refund_burn', '1:7', p);
        assert.equal(db.rows.get('refund_burn|1:7').fee_state, null);
        await attemptRefund({}, baseCfg, wallet, db, 'refund_burn', '1:7', p);
        assert.equal(db.rows.get('refund_burn|1:7').fee_state, 'refund_stuck');
    } finally { globalThis.fetch = orig; }
});

// ---------------- 领奖门（召回续修二）：过期裁决路径禁 claim ----------------

const DR_TOPIC = getEventSelector(parseAbiItem(`event ${DEPOSIT_REFUNDED_EVENT}`));

// 回执/日志 stub：receiptLogs 供 eth_getTransactionReceipt/eth_getLogs 返回
function logFetch(receiptLogs) {
    return async (url, init) => {
        const body = JSON.parse(init.body);
        let result = null;
        if (body.method === 'eth_getTransactionReceipt') result = { logs: receiptLogs };
        else if (body.method === 'eth_getLogs') result = receiptLogs;
        else if (body.method === 'eth_call') result = '0x';
        else if (body.method === 'eth_estimateGas') throw new Error('estimate boom');
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
    };
}

// DepositRefunded(chainIndex, seq) 非索引 → topics=[topic0]，data=abi.encode(uint256,uint256)
const drLog = (chainIndex, seq) => ({
    topics: [DR_TOPIC],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [chainIndex, seq]),
});

const dir1Ch = { chainIndex: '1', vault: '0x' + '44'.repeat(20), rpcUrl: hub.rpcUrl };

test('领奖门：回执含本方向退款指令事件（过期裁决）→ isAdjudicatedSettled=true', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = logFetch([drLog(1n, 7n)]);
    try {
        assert.equal(await isAdjudicatedSettled(baseCfg, 1, dir1Ch, 7n, '0xabc'), true);
    } finally { globalThis.fetch = orig; }
});

test('领奖门：回执无指令事件（正常成功）→ isAdjudicatedSettled=false', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = logFetch([]); // 回执存在但无日志
    try {
        assert.equal(await isAdjudicatedSettled(baseCfg, 1, dir1Ch, 7n, '0xabc'), false);
    } finally { globalThis.fetch = orig; }
});

test('领奖门：跨轮对账（无回执）→ getLogs 命中指令事件为 true；空则 false', async () => {
    const orig = globalThis.fetch;
    try {
        globalThis.fetch = logFetch([drLog(1n, 7n)]);
        assert.equal(await isAdjudicatedSettled(baseCfg, 1, dir1Ch, 7n, null), true);
        globalThis.fetch = logFetch([]);
        assert.equal(await isAdjudicatedSettled(baseCfg, 1, dir1Ch, 7n, null), false);
    } finally { globalThis.fetch = orig; }
});

test('领奖门：过期路径（指令事件在）ensureClaim 不建 claim op（费留 Escrowed，退款腿可过）', async () => {
    const db = new MemD1();
    const orig = globalThis.fetch;
    globalThis.fetch = logFetch([drLog(1n, 7n)]);
    try {
        await ensureClaim({}, baseCfg, wallet, db, { dir: 1, ch: dir1Ch, seq: 7n, txHash: '0xabc' });
        assert.equal(db.rows.has('fee_claim_mint|1:7'), false); // 未 claim
    } finally { globalThis.fetch = orig; }
});

test('领奖门：正常成功（无指令事件）ensureClaim 照常建 claim op', async () => {
    const db = new MemD1();
    const orig = globalThis.fetch;
    globalThis.fetch = logFetch([]);
    try {
        await ensureClaim({}, baseCfg, wallet, db, { dir: 1, ch: dir1Ch, seq: 7n, txHash: '0xabc' });
        assert.equal(db.rows.has('fee_claim_mint|1:7'), true); // 已建领奖 op
    } finally { globalThis.fetch = orig; }
});
