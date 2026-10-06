// 流E E4：双链 relayer 本地运行器（监听 31338 Deposit → hub executeMint(Swap)）。
//
// 用法（在 Stapleport_Bridge/Stapleport_Bridge/ 下）：
//   node scripts/relay-local-e.mjs [--ticks N] [--interval ms] [--dry] [--db FILE] [--out]
//     --ticks     连续 tick 数（默认 1；首个 tick 只落游标基线，第二个起处理事件）
//     --interval  tick 间隔毫秒（默认 1500）
//     --dry       DRY_RUN（只打印将发的交易，不广播）
//     --db        本地游标/幂等库文件（默认 /tmp/relay-local-e.sqlite3；删掉即重来）
//     --out       启用出向两向（hub LockOut → 外链 executeOutMint(Swap) + 外链 BurnOut →
//                 hub executeOutRelease）。通道参数从通道档案 "out" 键读（open-out-channel-
//                 78753.js 留痕：outKey/outVault/spN），缺参数即退出不猜。**缺省关闭**，
//                 不带 --out 时行为与旧版完全一致（彩排脚本依赖现状）。
//   env（07 彩排 hub=31339 时覆盖；缺省=78753 真值，78753 重放零改动）：
//     RELAY_HUB_CHAIN_ID   hub chainId（默认 78753）
//     RELAY_HUB_RPC        hub RPC（默认 https://rpc.stapleport.com）
//     RELAY_HUB_BUCKET     all.json 桶键（默认同 RELAY_HUB_CHAIN_ID）
//     RELAY_CHANNEL_FILE   通道档案（默认 test-channel-<RELAY_HUB_CHAIN_ID>.json）
//     RELAY_SPOKE_RPC      源链 RPC（默认 http://127.0.0.1:8546）
//     RELAY_SRC_KEY        key 内部编号（默认 1；RPC_URL_<n> 对应）
//
// 设计（任务书 E4「直接复用 e2e 的 relay 逻辑改双链版」落地）：
//   - 中继逻辑 100% 复用 src/relay.js（与生产 worker 同一份代码路径：relayForward/
//     relayReverse 入向两向 + --out 时的 relayOutForward/relayOutReverse 出向两向，
//     四向齐活），不 fork 不改源。
//   - D1 用 node:sqlite 本地文件顶替（只装 store.js 用到的两张表，语义同 D1：
//     cursors 游标 + ops 幂等抢占；INSERT OR IGNORE 原生支持）。
//   - 配置从命令行拼 env 后走 loadConfig（vars 优先口径，registry.json 兜底）。
//   - relayer 钥从总库 secrets/mnemonics.js 派生（正式=relayer 生产档；彩排=rehearsal-relayer）
//     （m/44'/60'/0'/0/0 = 通道 authority 0xDaFe…，与链上通道一致）。
//   - 78753 侧交易经 kit broadcastLegacy（显式 legacy gasPrice——零 baseFee 链纪律）。
//
// 已知边界（2026-09-18 执行报告 §3）：78753 老规格链（<Istanbul，CHAINID 无效）上
// 测试通道无押金（stakeNative 不可用），executeMint 会被 StakePool 覆盖/额度门拦下
// （revert "coverage exceeded"/"quota: bond insufficient"）——中继管线本身（事件解码→
// 抢占→编码→签名→广播→幂等对账）照常走完，错误按 ops 计次重试，与生产语义一致。
// 链规格修复并补押金后，本脚本零改动即为完整双链中继。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mnemonicToAccount } from 'viem/accounts';
import { loadConfig } from '../src/config.js';
import { relayForward, relayReverse, relayOutForward, relayOutReverse } from '../src/relay.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------- 参数 ----------------
const args = process.argv.slice(2);
const flag = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const TICKS = Number(flag('--ticks', '1'));
const INTERVAL = Number(flag('--interval', '1500'));
const DRY = args.includes('--dry');
const OUT = args.includes('--out');
const DB_FILE = flag('--db', '/tmp/relay-local-e.sqlite3');

// ---------------- 拓扑（hub + 31338 假想外链；地址从主仓 state 文件读） ----------------
const HUB_CHAIN_ID = process.env.RELAY_HUB_CHAIN_ID || '78753';
const HUB_RPC = process.env.RELAY_HUB_RPC || 'https://rpc.stapleport.com';
const HUB_BUCKET = process.env.RELAY_HUB_BUCKET || HUB_CHAIN_ID;
const CHANNEL_FILE = process.env.RELAY_CHANNEL_FILE || `test-channel-${HUB_CHAIN_ID}.json`;
const SPOKE_RPC = process.env.RELAY_SPOKE_RPC || 'http://127.0.0.1:8546';
const SRC_KEY = process.env.RELAY_SRC_KEY || '1';

const HARHAT = '/root/learn/Stapleport/Stapleport/Stapleport_hardhat';
const st31338 = JSON.parse(readFileSync(join(HARHAT, 'scripts/Token/state-31338.json'), 'utf8'));
const stCh = JSON.parse(readFileSync(join(HARHAT, 'scripts/Token', CHANNEL_FILE), 'utf8'));
const allHub = JSON.parse(readFileSync(join(HARHAT, 'deployments/all.json'), 'utf8'))[HUB_BUCKET];

const channels = [
    {
        chainIndex: stCh.chainIndex,
        srcToken: stCh.channels.usdt.srcToken,
        spToken: stCh.channels.usdt.spToken,
        srcDecimals: 18,
        vault: st31338.vault,
        covered: false, // 自家测试通道：不做 relayer gas 覆盖预检
    },
];
if (stCh.channels.wnative) {
    channels.push({
        chainIndex: stCh.chainIndex,
        srcToken: stCh.channels.wnative.srcToken,
        spToken: stCh.channels.wnative.spToken,
        srcDecimals: 18,
        vault: st31338.vault,
        covered: false,
    });
}

// ---------------- 出向通道（--out 启用；档案 "out" 键为准，缺参数即退出不猜） ----------------
let outChannels = [];
if (OUT) {
    const o = stCh.out;
    if (!o?.chainIndex || !o?.spoke?.outVault || !o?.spoke?.spN) {
        throw new Error('--out 已启用但通道档案缺 out.chainIndex/out.spoke.outVault/out.spoke.spN——先跑 scripts/Token/open-out-channel-78753.js 留痕');
    }
    outChannels = [{ chainIndex: o.chainIndex, vault: o.spoke.outVault, token: o.spoke.spN, covered: false }];
}

let relayerMnemonic;
if (BigInt(HUB_CHAIN_ID) === 78753n) {
    relayerMnemonic = createRequire(import.meta.url)('/root/learn/Stapleport/Stapleport/secrets/mnemonics.js').loadMnemonic('relayer'); // 正式=桥执行句生产档
} else {
    relayerMnemonic = createRequire(import.meta.url)('/root/learn/Stapleport/Stapleport/secrets/mnemonics.js').loadMnemonic('rehearsal-relayer'); // 彩排=旧句隔离拓扑
}
const wallet = mnemonicToAccount(relayerMnemonic); // m/44'/60'/0'/0/0

const env = {
    HUB_CHAIN_ID,
    RPC_URL_HUB: HUB_RPC,
    SPBRIDGE: allHub.StapleportBridge.address,
    STAKEPOOL: allHub.StakePool.address,
    CHANNELS: JSON.stringify(channels),
    OUT_CHANNELS: JSON.stringify(outChannels),
    [`RPC_URL_${SRC_KEY}`]: SPOKE_RPC,
    SRC_CHAINS: JSON.stringify({ [SRC_KEY]: { confirmations: 0 }, hub: { confirmations: 0 } }),
    DRY_RUN: String(DRY),
    TICK_LOCK_SECONDS: '1',
    MAX_ATTEMPTS: '3',
    API_BASE: '', // onboarding 关闭
    BRIDGE_RELAYER_PRIVATE_KEY: wallet.privateKey,
};

// ---------------- node:sqlite 顶替 D1 ----------------
const db = new DatabaseSync(DB_FILE);
db.exec(`create table if not exists cursors (chain_id text, name text, last_block text, updated_at integer, primary key (chain_id, name))`);
db.exec(`create table if not exists ops (direction text, op_key text, status text, created_at integer, updated_at integer, tx_hash text, attempts integer default 0, last_error text, payload text, primary key (direction, op_key))`);
// D1 形状适配：prepare().bind().first()/all()/run() + run() 返回 {meta:{changes}}
const d1 = {
    prepare(sql) {
        const stmt = db.prepare(sql);
        const wrap = (params) => ({
            async first() { return stmt.get(...params) ?? null; },
            async all() { return { results: stmt.all(...params) }; },
            async run() { const r = stmt.run(...params); return { meta: { changes: r.changes } }; },
        });
        // 兼容两种调用形：prepare().bind(...).all()（store.js 绝大多数）与
        // prepare().all() 直调（relay.js retryPendingReleases 无参语句）
        const unbound = wrap([]);
        return { ...unbound, bind: (...params) => wrap(params) };
    },
};

// ---------------- tick 循环 ----------------
const cfg = loadConfig(env);
cfg.relayerAddress = wallet.address;
console.log(`[e-runner] relayer=${wallet.address} 通道数=${cfg.channels.length} 出向=${OUT ? `${cfg.outChannels.length}（--out）` : '关'} hub=${cfg.hub.spBridge} dry=${cfg.dryRun} db=${DB_FILE}`);

for (let i = 1; i <= TICKS; i++) {
    console.log(`\n===== tick ${i}/${TICKS} =====`);
    await relayForward(env, cfg, wallet, d1);
    await relayReverse(env, cfg, wallet, d1);
    if (OUT) {
        await relayOutForward(env, cfg, wallet, d1);
        await relayOutReverse(env, cfg, wallet, d1);
    }
    if (i < TICKS) await new Promise((r) => setTimeout(r, INTERVAL));
}
const pending = await d1.prepare(`select direction, op_key, status, attempts, last_error from ops`).bind().all();
console.log('\n[e-runner] ops 表终态:');
for (const row of pending.results) console.log('  ', JSON.stringify(row));
console.log('[e-runner] 完成');
