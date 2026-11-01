// 流D D1：78756(hub) ↔ Sepolia(11155111, spoke) 双链四向 relayer 长跑运行器。
//
// clone 底本 = scripts/relay-local-e.mjs（本地 31339↔31338 彩排版）。差异仅 6 处（C6 契约）：
//   ① hub 默认 78756 / https://rpc-test.stapleport.com / 桶 78756 / 档案 test-channel-78756.json
//   ② spoke state 源 state-31338.json → state-11155111.json（B 线产物）
//   ③ relayer 钥 rehearsal-relayer(idx0) → 热句 idx107（walletAt({slot:"hot"},107)，
//      viem account；禁 rehearsal 槽）
//   ④ evmChainId 映射 spoke=11155111（经 state-11155111.json.chainId 自动取）
//   ⑤ confirmations hub=0 / spoke=6（C11 定 hub=2；但 78756 按需出块 + conf=2 使 burn 事件须等
//      2 新块才被拾取，孤笔事件在 buyDeadline(5min) 后才落地 → executeRelease 过期转 ReleaseSkipped、
//      资金不动。hub 改 0 即时拾取，落在窗口内）
//   ⑥ db=/tmp/relay-live-78756.sqlite
// 另：本档通道键名 channels.testusdt（非 usdt）且 TestUSDT=6 位小数（srcDecimals 6）；
//     四向长跑：--out 缺省开启（--no-out 关）。
// 召回续修（D 线二轮）：①hub confirmations 2→0（修 release 过期）；
//   ②进程内静态 oracle 桩（修 hub 付费方向准入门，见 ORACLE_STUB 注释）；
//   ③hub 侧 setFeeClaimAuthority=idx107（修 claimBurnFee "not fee claimer"）。余逻辑逐句照抄底本。
//
// 用法（在 Stapleport_Bridge/Stapleport_Bridge/ 下）：
//   node scripts/relay-live-78756.mjs [--ticks N] [--interval ms] [--dry] [--db FILE] [--no-out]
//     --ticks     连续 tick 数（默认 0=无限长跑；>0 为有限次，首个 tick 只落游标基线，第二个起处理事件）
//     --interval  tick 间隔毫秒（默认 1500）
//     --dry       DRY_RUN（只打印将发的交易，不广播）
//     --db        本地游标/幂等库文件（默认 /tmp/relay-live-78756.sqlite；删掉即重来）
//     --no-out    关闭出向两向（缺省四向全开）
//   env 覆盖：RELAY_HUB_CHAIN_ID / RELAY_HUB_RPC / RELAY_HUB_BUCKET / RELAY_CHANNEL_FILE /
//            RELAY_SPOKE_RPC / RELAY_SRC_KEY。
//
// 设计（照底本）：中继逻辑 100% 复用 src/relay.js 四向（relayForward/relayReverse +
//   relayOutForward/relayOutReverse）；D1 用 node:sqlite 本地文件顶替（cursors 游标 + ops 幂等抢占）；
//   配置走 loadConfig（vars 优先口径）；relayer 钥从总库 keyring 派生；hub 侧交易经 kit
//   broadcastLegacy（显式 legacy gasPrice——零 baseFee 链纪律）。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from '../src/config.js';
import { relayForward, relayReverse, relayOutForward, relayOutReverse } from '../src/relay.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------- 参数 ----------------
const args = process.argv.slice(2);
const flag = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const TICKS = Number(flag('--ticks', '0')) > 0 ? Number(flag('--ticks', '0')) : Infinity; // 默认无限长跑
const INTERVAL = Number(flag('--interval', '1500'));
const DRY = args.includes('--dry');
const OUT = !args.includes('--no-out'); // 四向长跑：出向缺省开启
const DB_FILE = flag('--db', '/tmp/relay-live-78756.sqlite');

// ---------------- 进程内静态 oracle 桩（修 hub 付费方向准入门） ----------------
// lib/fee.js 的准入门（admitCheck）用 oracle 归一出「relayer 奖励估值」，要求用户预付 paid ≥ reward×5+padFloor。
// 78756 与 Sepolia 均为测试网、原生币无真实 USD 价，且公网 oracle（https://oracle.stapleport.com）
// 不支持 chainId 11155111 → fetchGas 落 FALLBACK_PRICE(bnbUsdt=600)/FALLBACK_GAS_PRICE(10 gwei)
// → dir2/dir3 归一价放大，reward 估 ≈6.9/9.8 ETH，准入需 paid ≥ reward×5 ≈ 34.5/49 ETH（远超腿钱包余额）
// → hub 付费方向（dir2 burn 赎回 / dir3 lockOut）永不放行。
// 桩按测试网平价口径返回 nativePriceUsdt=1 + gasPriceGwei=0：reward=0（dir2/3，无 SP floor）/
// SP_FLOOR=1e14（dir1/4）→ 用户预付的 pad(+reward) 即足额准入。纯进程内 fetch 拦截，不依赖任何 worker/服务。
const ORACLE_STUB = { gasPriceGwei: 0, nativePriceUsdt: 1 };
const ORACLE_STUB_BASE = 'http://oracle-stub.local';
const _realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    if (url.includes('/gas?chainId=')) {
        return Promise.resolve(new Response(JSON.stringify(ORACLE_STUB), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return _realFetch(input, init);
};

// ---------------- 拓扑（hub=78756 + Sepolia 11155111；地址从主仓 state 文件读） ----------------
const HUB_CHAIN_ID = process.env.RELAY_HUB_CHAIN_ID || '78756';
const HUB_RPC = process.env.RELAY_HUB_RPC || 'https://rpc-test.stapleport.com';
const HUB_BUCKET = process.env.RELAY_HUB_BUCKET || HUB_CHAIN_ID;
const CHANNEL_FILE = process.env.RELAY_CHANNEL_FILE || `test-channel-${HUB_CHAIN_ID}.json`;
const SPOKE_RPC = process.env.RELAY_SPOKE_RPC || 'https://ethereum-sepolia-rpc.publicnode.com';
const SRC_KEY = process.env.RELAY_SRC_KEY || '1';

const HARHAT = '/root/learn/Stapleport/Stapleport/Stapleport_hardhat';
const stSpoke = JSON.parse(readFileSync(join(HARHAT, 'scripts/Token/state-11155111.json'), 'utf8'));
const stCh = JSON.parse(readFileSync(join(HARHAT, 'scripts/Token', CHANNEL_FILE), 'utf8'));
const allHub = JSON.parse(readFileSync(join(HARHAT, 'deployments/all.json'), 'utf8'))[HUB_BUCKET];

// evmChainId：relayer cfg 消费 oracle（GET /gas?chainId=）需链 id 映射；来源=state-11155111.json chainId
// （deploy 清单补值，bridge-fee L2 裁决项；缺此值则 feeDomain.evmChainId=undefined → oracle chainId=null
//  → 落 kit FALLBACK_PRICE）。
const SPOKE_EVM_CHAIN_ID = Number(stSpoke.chainId);
const channels = [
    {
        chainIndex: stCh.chainIndex,
        evmChainId: SPOKE_EVM_CHAIN_ID,
        srcToken: stCh.channels.testusdt.srcToken,
        spToken: stCh.channels.testusdt.spToken,
        srcDecimals: 6, // Sepolia TestUSDT=6 位小数（C9）；底本本地 testusdt 为 18 位
        vault: stSpoke.vault,
        covered: false, // 自家测试通道：不做 relayer gas 覆盖预检
    },
];
if (stCh.channels.wnative) {
    channels.push({
        chainIndex: stCh.chainIndex,
        evmChainId: SPOKE_EVM_CHAIN_ID,
        srcToken: stCh.channels.wnative.srcToken,
        spToken: stCh.channels.wnative.spToken,
        srcDecimals: 18,
        vault: stSpoke.vault,
        covered: false,
    });
}

// ---------------- 出向通道（--no-out 关闭；档案 "out" 键为准，缺参数即退出不猜） ----------------
let outChannels = [];
if (OUT) {
    const o = stCh.out;
    if (!o?.chainIndex || !o?.spoke?.outVault || !o?.spoke?.spN) {
        throw new Error('出向已启用但通道档案缺 out.chainIndex/out.spoke.outVault/out.spoke.spN——先跑 scripts/Token/open-out-channel-78756.js 留痕');
    }
    outChannels = [{ chainIndex: o.chainIndex, evmChainId: Number(o.spoke.chainId) || SPOKE_EVM_CHAIN_ID, vault: o.spoke.outVault, token: o.spoke.spN, covered: false }];
}

// 78756 hub relayer = 热句 idx107（通道 authority 0x2ED1…A459；禁 rehearsal 槽）。
// walletAt 返回 ethers HDNodeWallet，取 privateKey 转 viem account（relay.js 经 kit broadcastLegacy
// 调 wallet.signTransaction，须 viem account 形态）。
const { walletAt } = createRequire(import.meta.url)('/root/learn/Stapleport/Stapleport/Stapleport_hardhat/scripts/tool/keyring.js');
const wallet = privateKeyToAccount(walletAt({ slot: 'hot' }, 107).privateKey);

const env = {
    HUB_CHAIN_ID,
    RPC_URL_HUB: HUB_RPC,
    SPBRIDGE: allHub.StapleportBridge.address,
    STAKEPOOL: allHub.StakePool?.address, // 78756 桶无 StakePool 键；src/ 不消费（照抄底本保留位）
    CHANNELS: JSON.stringify(channels),
    OUT_CHANNELS: JSON.stringify(outChannels),
    [`RPC_URL_${SRC_KEY}`]: SPOKE_RPC,
    SRC_CHAINS: JSON.stringify({ [SRC_KEY]: { confirmations: 6 }, hub: { confirmations: 0 } }),
    DRY_RUN: String(DRY),
    TICK_LOCK_SECONDS: '1',
    MAX_ATTEMPTS: '3',
    API_BASE: '', // onboarding 关闭
    ORACLE_BASE: ORACLE_STUB_BASE, // 非空 → fetchGas 走进程内桩（见 ORACLE_STUB 注释）
    BRIDGE_RELAYER_PRIVATE_KEY: wallet.privateKey,
};

// ---------------- node:sqlite 顶替 D1 ----------------
const db = new DatabaseSync(DB_FILE);
db.exec(`create table if not exists cursors (chain_id text, name text, last_block text, updated_at integer, primary key (chain_id, name))`);
db.exec(`create table if not exists ops (direction text, op_key text, status text, created_at integer, updated_at integer, tx_hash text, attempts integer default 0, last_error text, payload text, fee_state text, fee_attempts integer default 0, primary key (direction, op_key))`);
// 兼容旧档：底本 shim 的 ops 缺 bridge-fee 两列（fee_state/fee_attempts，store.js setFeeState/
// bumpFeeAttempts/bumpStuckCount 消费）；已存在表按列补（禁删 /tmp 游标档）。
{
    const cols = db.prepare(`pragma table_info(ops)`).all().map((c) => c.name);
    if (!cols.includes('fee_state')) db.exec(`alter table ops add column fee_state text`);
    if (!cols.includes('fee_attempts')) db.exec(`alter table ops add column fee_attempts integer default 0`);
}
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
console.log(`[live-runner] relayer=${wallet.address} 通道数=${cfg.channels.length} 出向=${OUT ? `${cfg.outChannels.length}（四向）` : '关'} hub=${cfg.hub.spBridge} dry=${cfg.dryRun} db=${DB_FILE}`);

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
console.log('\n[live-runner] ops 表终态:');
for (const row of pending.results) console.log('  ', JSON.stringify(row));
console.log('[live-runner] 完成');
