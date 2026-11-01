// ABI 生成物等价性门禁（L1-1）：human-readable 唯一事实源（abi.js 数组）vs 构建期生成物
// （abi.gen.js）三重对拍：
//   ① 结构等价：生成 JSON ABI ≡ parseAbi(human 源)——改 abi.js 忘跑 scripts/gen-abi.mjs 时必红；
//   ② 编码等价：每个函数新旧两路（旧=运行时 parseAbi、新=生成 JSON ABI）同参 encodeFunctionData
//      输出逐字节一致（viem encode/decode 直收 JSON ABI 的行为等价证明）；
//   ③ topic0 等价：10 个扫链 topic 常量 ≡ 运行时 getEventSelector(parseAbiItem(...)) 重算值。
// 零网络/零 D1（node --test 直测，照 fee/refund 测试先例）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAbi, parseAbiItem, getEventSelector, encodeFunctionData } from 'viem';
import {
    vaultAbiHuman, spBridgeAbiHuman, registryAbiHuman, outVaultAbiHuman, erc20AbiHuman, instructionOutboxAbiHuman,
    DEPOSIT_EVENT, BURN_EVENT, LOCKOUT_EVENT, BURNOUT_EVENT,
    DEPOSIT_REFUNDED_EVENT, RELEASE_SKIPPED_EVENT, OUT_MINT_REFUNDED_EVENT, OUT_RELEASE_SKIPPED_EVENT,
    INSTRUCTION_EVENT, REFUNDED_EVENT,
} from '../src/lib/abi.js';
import {
    vaultAbi, spBridgeAbi, registryAbi, outVaultAbi, erc20Abi, instructionOutboxAbi,
    DEPOSIT_TOPIC0, BURN_TOPIC0, LOCKOUT_TOPIC0, BURNOUT_TOPIC0,
    DEPOSIT_REFUNDED_TOPIC0, RELEASE_SKIPPED_TOPIC0, OUT_MINT_REFUNDED_TOPIC0, OUT_RELEASE_SKIPPED_TOPIC0,
    INSTRUCTION_TOPIC0, REFUNDED_TOPIC0,
} from '../src/lib/abi.gen.js';

const ABI_PAIRS = [
    ['vaultAbi', vaultAbiHuman, vaultAbi],
    ['spBridgeAbi', spBridgeAbiHuman, spBridgeAbi],
    ['registryAbi', registryAbiHuman, registryAbi],
    ['outVaultAbi', outVaultAbiHuman, outVaultAbi],
    ['erc20Abi', erc20AbiHuman, erc20Abi],
    ['instructionOutboxAbi', instructionOutboxAbiHuman, instructionOutboxAbi],
];

// 确定性样例参数（按 ABI 类型递归构造；只求编码路径可跑通，值域无语义）
const SAMPLE_ADDR = '0x1111111111111111111111111111111111111111';
function sampleValue(type, components) {
    const i = type.indexOf('[');
    const base = i === -1 ? type : type.slice(0, i);
    const suffix = i === -1 ? '' : type.slice(i);
    let v;
    if (base === 'tuple') v = components.map((c) => sampleValue(c.type, c.components));
    else if (base === 'address') v = SAMPLE_ADDR;
    else if (base === 'bool') v = true;
    else if (base === 'string') v = 'sample';
    else if (base === 'bytes') v = '0x1234';
    else if (base.startsWith('bytes')) v = '0x' + 'ab'.repeat(Number(base.slice(5)));
    else if (base.startsWith('uint') || base.startsWith('int')) v = 7n;
    else throw new Error(`sampleValue: 未覆盖类型 ${type}`);
    if (suffix === '[]') return [v];
    const fixed = /^\[(\d+)\]$/.exec(suffix);
    if (fixed) return Array.from({ length: Number(fixed[1]) }, () => v);
    return v;
}

test('abi.gen.js 结构等价：生成 JSON ABI ≡ parseAbi(human 源)', () => {
    for (const [name, human, gen] of ABI_PAIRS) {
        assert.deepEqual(gen, parseAbi(human), `${name} 与事实源不一致（改 abi.js 后忘跑 node scripts/gen-abi.mjs？）`);
    }
});

test('abi.gen.js 编码等价：每个函数新旧两路 encodeFunctionData 逐字节一致', () => {
    let count = 0;
    for (const [name, human, gen] of ABI_PAIRS) {
        const oldAbi = parseAbi(human); // 旧路径 = 原运行时 parseAbi 现场解析
        const fns = oldAbi.filter((it) => it.type === 'function');
        assert.ok(fns.length > 0, `${name} 无函数条目（异常）`);
        const names = fns.map((f) => f.name);
        assert.equal(new Set(names).size, names.length, `${name} 存在重载名（按名编码需人工拆对）`);
        for (const f of fns) {
            const args = f.inputs.map((inp) => sampleValue(inp.type, inp.components));
            const viaOld = encodeFunctionData({ abi: oldAbi, functionName: f.name, args });
            const viaNew = encodeFunctionData({ abi: gen, functionName: f.name, args });
            assert.equal(viaNew, viaOld, `${name}.${f.name} 新旧编码不一致`);
            count++;
        }
    }
    assert.ok(count >= 60, `编码对拍函数数异常偏少：${count}`);
});

test('abi.gen.js topic0 等价：10 个扫链 topic 常量 ≡ 运行时 getEventSelector 重算', () => {
    const pairs = [
        [DEPOSIT_TOPIC0, DEPOSIT_EVENT],
        [BURN_TOPIC0, BURN_EVENT],
        [LOCKOUT_TOPIC0, LOCKOUT_EVENT],
        [BURNOUT_TOPIC0, BURNOUT_EVENT],
        [DEPOSIT_REFUNDED_TOPIC0, DEPOSIT_REFUNDED_EVENT],
        [RELEASE_SKIPPED_TOPIC0, RELEASE_SKIPPED_EVENT],
        [OUT_MINT_REFUNDED_TOPIC0, OUT_MINT_REFUNDED_EVENT],
        [OUT_RELEASE_SKIPPED_TOPIC0, OUT_RELEASE_SKIPPED_EVENT],
        [INSTRUCTION_TOPIC0, INSTRUCTION_EVENT],
        [REFUNDED_TOPIC0, REFUNDED_EVENT],
    ];
    for (const [constant, sig] of pairs) {
        assert.equal(constant, getEventSelector(parseAbiItem(`event ${sig}`)), `${sig} topic0 与重算值不一致`);
    }
});
