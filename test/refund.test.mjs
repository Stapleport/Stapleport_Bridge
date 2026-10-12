// refund.js 出向退款族消歧纯判定对拍（node --test，零网络/零 D1）。
// 覆盖 outMintFamilyOf：单族/双族视图消歧命中、两视图均 false（异常态）、双 true（歧义）、
// 视图族无对应通道配置（配置消歧失败）——异常态一律 err+direction（调用方 failOp 挂账、禁硬发）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outMintFamilyOf } from '../src/refund.js';

const NATIVE = { chainIndex: '1', vault: '0x' + 'aa'.repeat(20), srcToken: null };
const ERC20 = { chainIndex: '1', vault: '0x' + 'aa'.repeat(20), srcToken: '0x' + 'bb'.repeat(20) };

test('outMintFamilyOf: 单族 + 视图命中 → 定族且不错挂 err', () => {
    assert.deepEqual(outMintFamilyOf([NATIVE], true, false), { direction: 'refund_outlock', erc20: false });
    assert.deepEqual(outMintFamilyOf([ERC20], false, true), { direction: 'refund_outlock_e20', erc20: true });
});

test('outMintFamilyOf: 同链双族共 vault —— 以视图定族（native/erc20 键空间互不串）', () => {
    const dual = [NATIVE, ERC20];
    assert.deepEqual(outMintFamilyOf(dual, true, false), { direction: 'refund_outlock', erc20: false });
    assert.deepEqual(outMintFamilyOf(dual, false, true), { direction: 'refund_outlock_e20', erc20: true });
});

test('outMintFamilyOf: 两视图均 false=异常态 → err + 挂账锚（禁静默跳过）', () => {
    const single = outMintFamilyOf([NATIVE], false, false);
    assert.equal(single.direction, 'refund_outlock');
    assert.match(single.err, /both outMinted views false/);
    const dual = outMintFamilyOf([NATIVE, ERC20], false, false);
    assert.equal(dual.direction, 'refund_outlock'); // 双族锚 native
    assert.ok(dual.err);
    const ercOnly = outMintFamilyOf([ERC20], false, false);
    assert.equal(ercOnly.direction, 'refund_outlock_e20'); // 仅 erc20 族配置，锚 e20
});

test('outMintFamilyOf: 双 true=歧义 → err，不硬发', () => {
    const r = outMintFamilyOf([NATIVE, ERC20], true, true);
    assert.match(r.err, /ambiguous/);
});

test('outMintFamilyOf: 视图族与通道配置不符 → 配置消歧失败 err', () => {
    // 视图说 erc20，但无 erc20 通道配置
    const a = outMintFamilyOf([NATIVE], false, true);
    assert.match(a.err, /erc20 family but no erc20 outChannel/);
    assert.equal(a.direction, 'refund_outlock_e20');
    // 视图说 native，但无 native 通道配置
    const b = outMintFamilyOf([ERC20], true, false);
    assert.match(b.err, /native family but no native outChannel/);
    assert.equal(b.direction, 'refund_outlock');
    // 无任何通道配置 + 视图均 false
    const c = outMintFamilyOf([], false, false);
    assert.ok(c.err);
});
