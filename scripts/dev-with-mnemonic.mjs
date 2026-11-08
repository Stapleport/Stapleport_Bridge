// 本地 dev 包装：从总库 secrets/mnemonics.js 现取句派生桥 relayer 私钥，经 wrangler --var
// 注入进程环境后起 wrangler dev（.dev.vars 保持占位）。
// 用法：node scripts/dev-with-mnemonic.mjs [--print-args] [wrangler 额外参数...]
//
// 双钥分向（2026-11-03 换轨）：78756 hub 通道 authority = relayer 句 idx1
// （m/44'/60'/0'/0/1，0x5965…67FB）；Sepolia spoke 腿 authority = 热句 idx107
// （m/44'/60'/0'/0/107，0x2ED1…A459，用户裁决冻结）。
//   BRIDGE_RELAYER_PRIVATE_KEY      = 热句 idx107（spoke/base 腿，既有 secret 名不变）
//   BRIDGE_HUB_RELAYER_PRIVATE_KEY  = relayer 句 idx1（hub 腿）
// 生产：wrangler secret put 同名两条。本脚本不 print 私钥、不写临时文件，只经 --var 传参给子进程。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { mnemonicToAccount } = require('viem/accounts');
const { loadMnemonic } = createRequire(import.meta.url)('/root/learn/Stapleport/Stapleport/secrets/mnemonics.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(__dirname, '..'); // wrangler.jsonc 所在
const ENV_BASE = 'BRIDGE_RELAYER_PRIVATE_KEY';
const ENV_HUB = 'BRIDGE_HUB_RELAYER_PRIVATE_KEY';
const IDX_SRC = 107; // 热句 idx107：Sepolia spoke 腿 / feeClaimAuthority

const srcWallet = mnemonicToAccount(loadMnemonic('hot'), { addressIndex: IDX_SRC }); // m/44'/60'/0'/0/107
const hubWallet = mnemonicToAccount(loadMnemonic('relayer'), { addressIndex: 1 }); // m/44'/60'/0'/0/1

const userArgs = process.argv.slice(2);
const printArgs = userArgs.includes('--print-args');
const passthrough = userArgs.filter((a) => a !== '--print-args');

const argv = [
    'npx', 'wrangler', 'dev', '--local', ...passthrough,
    '--var', `${ENV_BASE}:${srcWallet.privateKey}`,
    '--var', `${ENV_HUB}:${hubWallet.privateKey}`,
];

if (printArgs) {
    // 私钥位打码：显示派生地址（公开），不显示私钥。
    const masked = argv.map((a) => {
        if (a.startsWith(`${ENV_BASE}:`)) return `${ENV_BASE}:${srcWallet.address.slice(0, 6)}…${srcWallet.address.slice(-4)}`;
        if (a.startsWith(`${ENV_HUB}:`)) return `${ENV_HUB}:${hubWallet.address.slice(0, 6)}…${hubWallet.address.slice(-4)}`;
        return a;
    });
    console.log('[dev-with-mnemonic] cwd:', REPO_DIR);
    console.log('[dev-with-mnemonic] argv:', masked.join(' '));
    console.log(`[dev-with-mnemonic] （两 env 值已打码；上行显示的是派生地址，非私钥：src=热句 idx${IDX_SRC} / hub=relayer idx1）`);
    process.exit(0);
}

const child = spawn(argv[0], argv.slice(1), { cwd: REPO_DIR, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
