// instructions.js 通用指令信封腿单测（node --test，纯函数 + 无链 smoke）。
// 覆盖：槽位填充（命中 SENTINEL 覆写/非 SENTINEL 跳过/无价 error/多槽）、价格 18 位缩放、
// registry 装载规范化 + env 覆盖、relayInstructions 空 registry 空转与对拍失败拒启不炸。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillSlots, SENTINEL_PRICE18, envKeyOf, relayInstructions } from '../src/instructions.js';
import { scaleTo18 } from '../src/lib/price.js';
import { parseInstructionRegistry, loadInstructionRegistry } from '../src/lib/instructions-registry.js';

const SEL = 'aabbccdd'; // 4 字节 selector 占位
const sentinelBody = SENTINEL_PRICE18.slice(2);

test('fillSlots: 命中 SENTINEL → 覆写 32 字节为 18 位价', () => {
    const data = `0x${SEL}${sentinelBody}`; // selector(4B) + 槽(32B) @ offset 4
    const price = 754770000000000000000n; // 754.77e18
    const r = fillSlots(data, [{ offset: 4, kind: 'bnbRefPrice18' }], { bnbRefPrice18: price });
    assert.equal(r.error, null);
    assert.equal(r.filled, 1);
    assert.equal(r.data.length, data.length); // 长度不变（等宽覆写）
    assert.equal(r.data.slice(10, 74), price.toString(16).padStart(64, '0'));
    assert.equal(r.data.slice(0, 10), `0x${SEL}`); // 前段不动
});

test('fillSlots: 非 SENTINEL 槽位 → 跳过并告警（不错位覆写）', () => {
    const data = `0x${SEL}${'11'.repeat(32)}`; // 槽位非哨兵
    const r = fillSlots(data, [{ offset: 4, kind: 'bnbRefPrice18' }], { bnbRefPrice18: 1n });
    assert.equal(r.error, null);
    assert.equal(r.filled, 0);
    assert.equal(r.data, data); // 原样
    assert.deepEqual(r.skipped, [{ kind: 'bnbRefPrice18', offset: 4, reason: 'not sentinel' }]);
});

test('fillSlots: 某 kind 无价 → error（调用方本轮 skip）', () => {
    const data = `0x${SEL}${sentinelBody}`;
    const r = fillSlots(data, [{ offset: 4, kind: 'bnbRefPrice18' }], {});
    assert.match(r.error, /no price for kind bnbRefPrice18/);
});

test('fillSlots: 多槽位各自独立填 + 越界槽跳过', () => {
    const data = `0x${SEL}${sentinelBody}${sentinelBody}`; // 两槽 @ 4 与 36
    const r = fillSlots(data, [{ offset: 4, kind: 'a' }, { offset: 36, kind: 'b' }, { offset: 999, kind: 'a' }], { a: 2n, b: 3n });
    assert.equal(r.filled, 2);
    assert.equal(r.data.slice(10, 74), '2'.padStart(64, '0'));
    assert.equal(r.data.slice(74, 138), '3'.padStart(64, '0'));
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].reason, 'out of range');
});

test('scaleTo18: 2 位/整数/多小数位', () => {
    assert.equal(scaleTo18('754.77'), 754770000000000000000n);
    assert.equal(scaleTo18(754.77), 754770000000000000000n);
    assert.equal(scaleTo18('1'), 1000000000000000000n);
    assert.equal(scaleTo18('0.5'), 500000000000000000n);
    assert.throws(() => scaleTo18('abc'));
});

test('envKeyOf: dstChain+outboxAddr 小写+seq；seq 恒为末段（Refunded 对账 LIKE 尾部锚定不撞 1/10）', () => {
    const addr = '0x' + 'Aa'.repeat(20);
    assert.equal(envKeyOf('78753', addr, 7), `env:78753:${addr.toLowerCase()}:7`);
    // Refunded 对账用 `op_key like 'env:%:<addr>:<seq>'`（尾部无 %，SQL LIKE 端锚定）。
    // 模拟：seq=1 的模式须不匹配 seq=10 的 key（endsWith(':1') vs key 尾 '10'）。
    const key10 = envKeyOf('78753', addr, 10);
    const pat1Suffix = `:${1}`;
    assert.ok(key10.endsWith(':10') && !key10.endsWith(pat1Suffix));
});

test('parseInstructionRegistry: 规范化 target/outbox/chain 键与 addr', () => {
    const reg = parseInstructionRegistry({
        chains: { 31337: { rpcUrl: 'http://x', confirmations: 1 } },
        outboxes: [{ chainIndex: 31337, addr: '0x' + 'AA'.repeat(20) }],
        targets: { ['0x' + 'BB'.repeat(32)]: { srcChain: 31337, dstChain: 78753, addr: '0x' + 'CC'.repeat(20), slots: [{ offset: 4, kind: 'bnbRefPrice18' }] } },
    });
    assert.equal(reg.outboxes[0].chainIndex, '31337');
    assert.equal(reg.outboxes[0].addr, '0x' + 'aa'.repeat(20));
    assert.ok(reg.targets['0x' + 'bb'.repeat(32)]);
    assert.equal(reg.targets['0x' + 'bb'.repeat(32)].dstChain, '78753');
    assert.equal(reg.chains['31337'].confirmations, 1);
});

test('loadInstructionRegistry: 缺省读文件(source=file)，env 空覆盖 → 空转（不依赖文件当前内容）', () => {
    // 缺省无 env → 读文件本体，只断言 source 不依赖文件内容（文件值随部署变动）。
    assert.equal(loadInstructionRegistry({}).source, 'file');
    // 显式空 registry 覆盖（浅合并、键整体替换）→ outboxes 空转，与文件字段无关。
    const empty = loadInstructionRegistry({
        INSTRUCTION_REGISTRY: JSON.stringify({ chains: {}, outboxes: [], targets: {} }),
    });
    assert.equal(empty.source, 'env');
    assert.equal(empty.outboxes.length, 0);
    const env = {
        INSTRUCTION_REGISTRY: JSON.stringify({
            chains: { 1: { rpcUrl: 'http://127.0.0.1:1' } },
            outboxes: [{ chainIndex: 1, addr: '0x' + 'aa'.repeat(20) }],
            targets: {},
        }),
    };
    const reg = loadInstructionRegistry(env);
    assert.equal(reg.source, 'env');
    assert.equal(reg.outboxes.length, 1);
});

test('relayInstructions smoke: 空 registry → 空转不炸', async () => {
    // 显式空 registry 覆盖，不读真实文件（部署后文件非空）。
    const env = { INSTRUCTION_REGISTRY: JSON.stringify({ chains: {}, outboxes: [], targets: {} }) };
    await assert.doesNotReject(relayInstructions(env, {}, {}, null));
});

test('relayInstructions smoke: 对拍读链失败（不可达 rpc）→ 拒启返回，不抛', async () => {
    const env = {
        INSTRUCTION_REGISTRY: JSON.stringify({
            chains: { 1: { rpcUrl: 'http://127.0.0.1:1' } },
            outboxes: [{ chainIndex: 1, addr: '0x' + 'aa'.repeat(20) }],
            targets: { ['0x' + '11'.repeat(32)]: { srcChain: 1, dstChain: '78753', addr: '0x' + '22'.repeat(20), slots: [] } },
        }),
    };
    await assert.doesNotReject(relayInstructions(env, {}, {}, null));
});
