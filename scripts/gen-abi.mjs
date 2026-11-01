// ABI 构建期预编译（L1-1，CPU 优化）：src/lib/abi.js 的 human-readable 数组（唯一事实源）
// → src/lib/abi.gen.js（JSON ABI 常量 + 扫链事件 topic0 常量）。运行时零解析——viem 的
// encode/decode 直收 JSON ABI；topic0 = getEventSelector(parseAbiItem(...)) 构建期算定，
// 免掉冷 isolate 模块初始化里的 human-readable 正则解析 + keccak selector 计算。
// 改 abi.js 的 human 数组/事件签名后必须重跑本脚本（test/abi-gen.test.mjs 等价性门禁会红）。
// 用法：node scripts/gen-abi.mjs
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseAbi, parseAbiItem, getEventSelector } from 'viem';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'src', 'lib', 'abi.gen.js');

// ABI 常量（生成名 = 运行时导入名，abi.js re-export 保持消费者零改动）
const ABI_NAMES = [
    ['vaultAbi', 'vaultAbiHuman'],
    ['spBridgeAbi', 'spBridgeAbiHuman'],
    ['registryAbi', 'registryAbiHuman'],
    ['outVaultAbi', 'outVaultAbiHuman'],
    ['erc20Abi', 'erc20AbiHuman'],
    ['instructionOutboxAbi', 'instructionOutboxAbiHuman'],
];

// 扫链 topic0（relay.js/refund.js/instructions.js 原运行时 getEventSelector 计算点，共 14 处调用位）
const TOPIC_NAMES = [
    ['DEPOSIT_TOPIC0', 'DEPOSIT_EVENT'],
    ['BURN_TOPIC0', 'BURN_EVENT'],
    ['LOCKOUT_TOPIC0', 'LOCKOUT_EVENT'],
    ['BURNOUT_TOPIC0', 'BURNOUT_EVENT'],
    ['DEPOSIT_REFUNDED_TOPIC0', 'DEPOSIT_REFUNDED_EVENT'],
    ['RELEASE_SKIPPED_TOPIC0', 'RELEASE_SKIPPED_EVENT'],
    ['OUT_MINT_REFUNDED_TOPIC0', 'OUT_MINT_REFUNDED_EVENT'],
    ['OUT_RELEASE_SKIPPED_TOPIC0', 'OUT_RELEASE_SKIPPED_EVENT'],
    ['INSTRUCTION_TOPIC0', 'INSTRUCTION_EVENT'],
    ['REFUNDED_TOPIC0', 'REFUNDED_EVENT'],
];

// 自举：abi.js 静态 re-export abi.gen.js，首跑（生成物缺席）先落占位 stub 再动态 import
//（human 数组定义在 abi.js 本体、与 stub 内容无关，取到即覆写真生成物）。
if (!existsSync(outPath)) {
    const stub = [...ABI_NAMES, ...TOPIC_NAMES].map(([n]) => `export const ${n} = null;\n`).join('');
    writeFileSync(outPath, `// 自举占位（首跑生成中覆写）\n${stub}`);
}
const {
    ...abiSrc
} = await import('../src/lib/abi.js');

let out = `// 生成物勿手改——由 scripts/gen-abi.mjs 从 src/lib/abi.js（human-readable 唯一事实源）构建期生成。
// 再生成命令：node scripts/gen-abi.mjs
// 内容：JSON ABI 常量（viem encode/decode 直收，运行时零解析）+ 事件 topic0 常量
// （事件选择器构建期算定，与原各调用点运行时计算逐字一致）。
`;
let entryCount = 0;
for (const [name, srcName] of ABI_NAMES) {
    const human = abiSrc[srcName];
    entryCount += human.length;
    out += `export const ${name} = ${JSON.stringify(parseAbi(human))};\n`;
}
for (const [name, srcName] of TOPIC_NAMES) {
    out += `export const ${name} = ${JSON.stringify(getEventSelector(parseAbiItem(`event ${abiSrc[srcName]}`)))};\n`;
}
writeFileSync(outPath, out);
console.log(`abi.gen.js 已生成：${ABI_NAMES.length} 组 ABI（共 ${entryCount} 条）+ ${TOPIC_NAMES.length} 个 topic0 → ${outPath}`);
