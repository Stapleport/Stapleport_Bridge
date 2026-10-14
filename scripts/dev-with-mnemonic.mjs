// 本地 dev 包装：从总库 secrets/mnemonics.js 现取热句派生桥 relayer 私钥（idx107），
// 经 wrangler --var 注入进程环境后起 wrangler dev（.dev.vars 保持占位）。
// 用法：node scripts/dev-with-mnemonic.mjs [--print-args] [wrangler 额外参数...]
//
// BRIDGE_RELAYER_PRIVATE_KEY = 热句 idx107（m/44'/60'/0'/0/107），= 测试桥通道 authority
// （口径见 secrets/bridge-test.dev.vars 与地址总表）。生产：wrangler secret put BRIDGE_RELAYER_PRIVATE_KEY。
// 本脚本不 print 私钥、不写临时文件，只经 --var NAME:value 传参给子进程。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { mnemonicToAccount } = require('viem/accounts');
const { loadMnemonic } = createRequire(import.meta.url)('/root/learn/Stapleport/Stapleport/secrets/mnemonics.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(__dirname, '..'); // wrangler.jsonc 所在
const ENV_NAME = 'BRIDGE_RELAYER_PRIVATE_KEY';
const IDX = 107; // 位序制：热句 idx107（桥 relayer 测试档 authority）

const phrase = loadMnemonic('hot');
const wallet = mnemonicToAccount(phrase, { addressIndex: IDX }); // m/44'/60'/0'/0/107

const userArgs = process.argv.slice(2);
const printArgs = userArgs.includes('--print-args');
const passthrough = userArgs.filter((a) => a !== '--print-args');

const argv = ['npx', 'wrangler', 'dev', '--local', ...passthrough, '--var', `${ENV_NAME}:${wallet.privateKey}`];

if (printArgs) {
    // 私钥位打码：显示派生地址（公开），不显示私钥。
    const masked = argv.map((a) => (a.startsWith(`${ENV_NAME}:`) ? `${ENV_NAME}:${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : a));
    console.log('[dev-with-mnemonic] cwd:', REPO_DIR);
    console.log('[dev-with-mnemonic] argv:', masked.join(' '));
    console.log(`[dev-with-mnemonic] （${ENV_NAME} 值已打码；上行显示的是热句 idx${IDX} 派生地址，非私钥）`);
    process.exit(0);
}

const child = spawn(argv[0], argv.slice(1), { cwd: REPO_DIR, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
