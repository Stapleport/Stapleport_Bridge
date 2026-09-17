// onboarding.js + config.js 派生层 stub 对拍（node --test，fetch/wallet/D1 全 stub 不碰网络，
// 风格对齐 tx.test.mjs）。链语义用 viem encode/decode 搭最小模拟器：
//   - eth_call 按 selector 路由到内存态（ChainRegistry/StapleportBridge/StakePool/Vault）
//   - wallet.signTransaction 即时落账（模拟「广播即出块」，同 tick 重读立即可见）
//   - D1 只装 onboard 表的精确 SQL 形状
// 覆盖：状态机推进顺序 / registerChain 幂等复用 / setChainIndex 已非 0 跳过 /
// openChannel "channel exists" 容错 / 押金不足停 awaiting_stake / vars override 优先于派生。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { loadConfig, deriveTopology } from '../src/config.js';
import { onboardingTick } from '../src/onboarding.js';
import { channelKeyOf, outKeyOf, ZERO_ADDRESS } from '../src/relay.js';
import { registryAbi, stplBridgeAbi, stakePoolAbi, vaultAbi, outVaultAbi } from '../src/lib/abi.js';
import {
    ensureOnboardRow, setOnboardStatus, setOnboardIndex, setOnboardDetail,
} from '../src/lib/store.js';

const W = 10n ** 18n;
const ZERO = ZERO_ADDRESS;
const HUB_RPC = 'https://hub.example';
const SPOKE_RPC = 'https://spoke.example';
const API_BASE = 'https://api.example';
const BRIDGE = '0x' + '11'.repeat(20);
const REG = '0x' + '22'.repeat(20);
const POOL = '0x' + '33'.repeat(20);
const VAULT = '0x' + '44'.repeat(20);
const OUTVAULT = '0x' + '55'.repeat(20);
const OUTTOKEN = '0x' + '66'.repeat(20);
const RELAYER = '0x' + '77'.repeat(20);
const STPL = '0x' + '88'.repeat(20);

// 合并 ABI 做双向编解码（去重：vault/outVault 的 chainIndex/setChainIndex 签名相同）
const SIM_ABI = [...new Map(
    [...registryAbi, ...stplBridgeAbi, ...stakePoolAbi, ...vaultAbi, ...outVaultAbi]
        .map((item) => [JSON.stringify(item), item]),
).values()];

const normJs = (s) => String(s ?? '').trim().toLowerCase().replace(/\/+$/, '');

// ---------------- 链模拟器 ----------------

function mkState({ apiChains = [] } = {}) {
    return {
        apiBase: API_BASE,
        apiChains,
        registry: { nextIndex: 1n, chains: new Map(), byChainId: new Map() }, // idx → {evmChainId, rpc, mergedInto, active}
        bridge: { registryAddr: REG, channels: new Map(), outChannels: new Map() }, // key → {stplToken, authority} / {authority}
        vaults: new Map([[VAULT.toLowerCase(), { chainIndex: 0n }], [OUTVAULT.toLowerCase(), { chainIndex: 0n }]]),
        stake: new Map(), // channelKey(小写) → boundValue(wei)
        stplSeq: 0,
        failOn: null, // { fn, message }：让对应函数在「广播」时 revert（且不落账/不记录）
    };
}

function nextStpl(st) {
    return '0x' + (++st.stplSeq).toString(16).padStart(40, '0');
}

function simCall(st, to, data) {
    // 返回 { functionName, value }：value 为「ABI 编码前」的返回值，由 fetch 层 encodeFunctionResult
    const { functionName: fn, args = [] } = decodeFunctionData({ abi: SIM_ABI, data });
    const T = String(to).toLowerCase();
    switch (fn) {
        case 'nextIndex': return { fn, value: st.registry.nextIndex };
        case 'lookupByChainId': return { fn, value: st.registry.byChainId.get(String(args[0])) ?? [] };
        case 'resolve': {
            const c = st.registry.chains.get(String(args[0]))
                ?? { evmChainId: 0n, rpc: '', mergedInto: 0n, active: false };
            return { fn, value: [args[0], [c.evmChainId, c.rpc, c.mergedInto, c.active]] };
        }
        case 'registry': return { fn, value: st.bridge.registryAddr };
        case 'getChannel': {
            const ch = st.bridge.channels.get(String(args[0]).toLowerCase());
            return {
                fn,
                value: ch ? [0n, ZERO, ch.stplToken, ch.authority, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, true]
                    : [0n, ZERO, ZERO, ZERO, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, false],
            };
        }
        case 'getOutChannel': {
            const oc = st.bridge.outChannels.get(String(args[0]).toLowerCase());
            return { fn, value: oc ? [0n, oc.authority, 0n, 0n, 0n, 0n, true] : [0n, ZERO, 0n, 0n, 0n, 0n, false] };
        }
        case 'boundValueOf': return { fn, value: st.stake.get(String(args[0]).toLowerCase()) ?? 0n };
        case 'chainIndex': return { fn, value: st.vaults.get(T)?.chainIndex ?? 0n };
        default: throw new Error(`sim: unhandled call ${fn}`);
    }
}

// 签名即落账（模拟出块）；failOn 命中则抛 revert 且不落账（签名也不记录）
function applyTx(st, tx) {
    const { functionName: fn, args = [] } = decodeFunctionData({ abi: SIM_ABI, data: tx.data });
    if (st.failOn?.fn === fn) throw new Error(st.failOn.message);
    const T = String(tx.to).toLowerCase();
    if (fn === 'registerChain') {
        const [cid, rpcUrl] = args;
        for (const c of st.registry.chains.values()) {
            if (c.evmChainId === cid && normJs(c.rpc) === normJs(rpcUrl)) throw new Error('chain+rpc already registered');
        }
        const idx = st.registry.nextIndex++;
        st.registry.chains.set(String(idx), { evmChainId: cid, rpc: normJs(rpcUrl), mergedInto: 0n, active: true });
        const arr = st.registry.byChainId.get(String(cid)) ?? [];
        arr.push(idx);
        st.registry.byChainId.set(String(cid), arr);
        return;
    }
    if (fn === 'setChainIndex') {
        const v = st.vaults.get(T);
        if (!v) throw new Error('no such vault');
        v.chainIndex = args[0];
        return;
    }
    if (fn === 'openChannel') {
        const p = args[0];
        const key = channelKeyOf(p.chainIndex, p.srcToken).toLowerCase();
        if (st.bridge.channels.has(key)) throw new Error('channel exists');
        st.bridge.channels.set(key, { stplToken: nextStpl(st), authority: p.authority });
        return;
    }
    if (fn === 'openOutChannel') {
        const p = args[0];
        const key = outKeyOf(p.chainIndex).toLowerCase();
        if (st.bridge.outChannels.has(key)) throw new Error('out channel exists');
        st.bridge.outChannels.set(key, { authority: p.authority });
        return;
    }
    throw new Error(`sim: unhandled tx ${fn}`);
}

function mkFetch(st) {
    return async (url, init) => {
        const u = String(url);
        if (u.startsWith(st.apiBase)) {
            return new Response(JSON.stringify({ success: true, chains: st.apiChains }), { status: 200 });
        }
        const body = JSON.parse(init.body);
        try {
            let result;
            if (body.method === 'eth_call') {
                const { fn, value } = simCall(st, body.params[0].to, body.params[0].data);
                result = encodeFunctionResult({ abi: SIM_ABI, functionName: fn, result: value });
            }
            else if (body.method === 'eth_estimateGas') result = '0x5208';
            else if (body.method === 'eth_getTransactionCount') result = '0x7';
            else if (body.method === 'eth_chainId') result = '0x1';
            else if (body.method === 'eth_gasPrice') result = '0x1';
            else if (body.method === 'eth_sendRawTransaction') result = '0xhash0';
            else throw new Error(`sim: unhandled ${body.method}`);
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
        } catch (e) {
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: String(e.message) } }), { status: 200 });
        }
    };
}

function mkWallet(st) {
    const signed = [];
    return {
        address: RELAYER,
        signTransaction: async (tx) => {
            applyTx(st, tx); // 即时出块
            signed.push({ to: String(tx.to), data: tx.data });
            return '0xsigned';
        },
        signed,
    };
}

// onboard 表最小 D1（只装 store.js 里 onboard 相关 SQL 的精确形状，键/参序逐分支对齐）
class OnboardD1 {
    constructor() { this.rows = new Map(); }
    prepare(sql) { return new Stmt(this, sql); }
}
class Stmt {
    constructor(db, sql) { this.db = db; this.sql = sql.replace(/\s+/g, ' ').trim(); this.args = []; }
    bind(...a) { this.args = a; return this; }
    async run() {
        const [sql, a] = [this.sql, this.args];
        const meta = (ok) => ({ meta: { changes: ok ? 1 : 0 } });
        if (sql.startsWith('insert or ignore into onboard')) {
            const key = String(a[0]);
            const inserted = !this.db.rows.has(key);
            if (inserted) {
                this.db.rows.set(key, { chain_id: a[0], status: 'registered', chain_index: null, detail: null, updated_at: a[1] });
            }
            return meta(inserted);
        }
        if (sql.startsWith('update onboard set status')) {
            const row = this.db.rows.get(String(a[2]));
            const ok = Boolean(row) && row.status === a[3];
            if (ok) { row.status = a[0]; row.updated_at = a[1]; }
            return meta(ok);
        }
        if (sql.startsWith('update onboard set chain_index')) {
            const row = this.db.rows.get(String(a[2]));
            if (row) { row.chain_index = String(a[0]); row.updated_at = a[1]; }
            return meta(Boolean(row));
        }
        if (sql.startsWith('update onboard set detail')) {
            const row = this.db.rows.get(String(a[2]));
            if (row) { row.detail = a[0]; row.updated_at = a[1]; }
            return meta(Boolean(row));
        }
        throw new Error(`d1 shim: unhandled ${sql}`);
    }
    async first() {
        if (this.sql.startsWith('select * from onboard where chain_id=?')) {
            return this.db.rows.get(String(this.args[0])) ?? null;
        }
        return null;
    }
    async all() {
        if (this.sql.startsWith('select * from onboard where status=?')) {
            return { results: [...this.db.rows.values()].filter((r) => r.status === this.args[0]) };
        }
        if (this.sql.startsWith('select chain_id, status, chain_index, updated_at from onboard')) {
            return { results: [...this.db.rows.values()].map((r) => ({ ...r })) };
        }
        return { results: [] };
    }
}

// ---------------- 环境小件 ----------------

const ROW = {
    chain_id: 999, name: 'OpChain', rpc: SPOKE_RPC, explorer: null,
    status: 'active', project: 'bridge', native_symbol: 'OP', native_decimals: 18,
    contracts: { BridgeVault: VAULT, OutVault: OUTVAULT, OutToken: OUTTOKEN },
};

function mkEnv(overrides = {}) {
    return {
        HUB_CHAIN_ID: '78753',
        RPC_URL_HUB: HUB_RPC,
        STPLBRIDGE: BRIDGE,
        STAKEPOOL: POOL,
        CHANNELS: '[]',
        OUT_CHANNELS: '[]',
        SRC_CHAINS: '{}',
        API_BASE: API_BASE,
        ...overrides,
    };
}

async function withFetch(st, fn) {
    const orig = globalThis.fetch;
    globalThis.fetch = mkFetch(st);
    try { return await fn(); } finally { globalThis.fetch = orig; }
}

function fnSequence(wallet) {
    return wallet.signed.map(({ data }) => decodeFunctionData({ abi: SIM_ABI, data }).functionName);
}

async function captureWarn(fn) {
    const warns = [];
    const orig = console.warn;
    console.warn = (m) => warns.push(String(m));
    try { return [await fn(), warns]; } finally { console.warn = orig; }
}

// 直接把某链插成 active 档案（派生层测试用）
async function seedActive(db, chainId, chainIndex, detail) {
    await ensureOnboardRow(db, chainId);
    await setOnboardIndex(db, chainId, chainIndex);
    await setOnboardDetail(db, chainId, detail);
    for (const [from, to] of [['registered', 'indexed'], ['indexed', 'channeled'], ['channeled', 'awaiting_stake'], ['awaiting_stake', 'active']]) {
        await setOnboardStatus(db, chainId, from, to);
    }
}

const boundBoth = (st, idx, wei) => {
    st.stake.set(channelKeyOf(idx, ZERO).toLowerCase(), wei);
    st.stake.set(outKeyOf(idx).toLowerCase(), wei);
};

// ---------------- 用例 ----------------

test('状态机推进：registered→indexed→channeled→awaiting_stake→active，active 后派生进运行时 config', async () => {
    const st = mkState({ apiChains: [ROW] });
    const db = new OnboardD1();
    const env = mkEnv();
    const wallet = mkWallet(st);
    await withFetch(st, async () => {
        const cfg = loadConfig(env);
        // 首轮：注册→后配→开出向全部广播（模拟器即时落账，通道重读确认留到下轮）
        await onboardingTick(env, cfg, wallet, db);
        let row = [...db.rows.values()][0];
        assert.equal(row.status, 'channeled');
        assert.equal(row.chain_index, '1'); // registry 从 1 起颁索引
        assert.deepEqual(fnSequence(wallet), ['registerChain', 'setChainIndex', 'setChainIndex', 'openOutChannel']);

        // 次轮：出向通道重读确认 → awaiting_stake；押金未配 → warn 停住
        await captureWarn(() => onboardingTick(env, cfg, wallet, db));
        row = [...db.rows.values()][0];
        assert.equal(row.status, 'awaiting_stake');
        assert.equal(fnSequence(wallet).length, 4); // 本轮零新增广播

        // 押金不足：继续停住（warn），绝不自动质押（广播序列不变）
        boundBoth(st, 1n, 100n * W);
        const [, warns] = await captureWarn(() => onboardingTick(env, cfg, wallet, db));
        assert.equal([...db.rows.values()][0].status, 'awaiting_stake');
        assert.ok(warns.some((m) => m.includes('押金未达标') && m.includes('awaiting_stake') && m.includes('绝不自动质押')));
        assert.equal(fnSequence(wallet).length, 4);

        // 押金达标 → active；派生层把链拓扑并入运行时 config
        boundBoth(st, 1n, 200n * W);
        await onboardingTick(env, cfg, wallet, db);
        assert.equal([...db.rows.values()][0].status, 'active');

        await deriveTopology(env, cfg, db);
        assert.equal(cfg.channels.length, 0); // 入向通道不自动开（挂 ERC20、按 token 另行开启）
        assert.equal(cfg.outChannels.length, 1);
        assert.equal(cfg.outChannels[0].chainIndex, '1');
        assert.equal(cfg.outChannels[0].vault, OUTVAULT);
        assert.equal(cfg.outChannels[0].token, OUTTOKEN);
        assert.equal(cfg.outChannels[0].covered, true);
        assert.equal(cfg.srcChains['1'].rpcUrl, SPOKE_RPC); // registry rpc 口径
        assert.equal(cfg.srcChains['1'].confirmations, 3n);
    });
});

test('registerChain 幂等：registry 已有同 (chainId, 规范化rpc) 索引 → 复用不重注，全链路零广播', async () => {
    const st = mkState({ apiChains: [{ ...ROW, rpc: 'HTTPS://SPOKE.Example///' }] }); // 规范化后同键
    st.registry.chains.set('1', { evmChainId: 999n, rpc: 'https://spoke.example', mergedInto: 0n, active: true });
    st.registry.byChainId.set('999', [1n]);
    st.registry.nextIndex = 2n;
    st.vaults.get(VAULT.toLowerCase()).chainIndex = 1n; // 后配也已做过
    st.vaults.get(OUTVAULT.toLowerCase()).chainIndex = 1n;
    st.bridge.channels.set(channelKeyOf(1n, ZERO).toLowerCase(), { stplToken: STPL, authority: RELAYER });
    st.bridge.outChannels.set(outKeyOf(1n).toLowerCase(), { authority: RELAYER });
    boundBoth(st, 1n, 200n * W);

    const db = new OnboardD1();
    const env = mkEnv();
    const wallet = mkWallet(st);
    await withFetch(st, async () => {
        const cfg = loadConfig(env);
        await onboardingTick(env, cfg, wallet, db);
        assert.deepEqual(fnSequence(wallet), []); // 全部复用：零广播
        const row = [...db.rows.values()][0];
        assert.equal(row.status, 'active');
        assert.equal(row.chain_index, '1'); // 复用的 registry 索引
    });
});

test('setChainIndex 已非 0：等于期望则跳过；期值不符则停住告警且不再碰该金库', async () => {
    // 已非 0 且等于期望：不重发，只注册+开通道
    const st = mkState({ apiChains: [ROW] });
    st.vaults.get(VAULT.toLowerCase()).chainIndex = 1n;
    st.vaults.get(OUTVAULT.toLowerCase()).chainIndex = 1n;
    const db = new OnboardD1();
    const env = mkEnv();
    const wallet = mkWallet(st);
    await withFetch(st, async () => {
        const cfg = loadConfig(env);
        await onboardingTick(env, cfg, wallet, db);
        await onboardingTick(env, cfg, wallet, db);
        assert.deepEqual(fnSequence(wallet), ['registerChain', 'openOutChannel']);
        assert.equal([...db.rows.values()][0].status, 'awaiting_stake');
    });

    // 已非 0 但与期望不符（串链）：主金库停住告警；出向金库仍为 0 可正常后配
    const st2 = mkState({ apiChains: [ROW] });
    st2.registry.chains.set('1', { evmChainId: 999n, rpc: SPOKE_RPC, mergedInto: 0n, active: true });
    st2.registry.byChainId.set('999', [1n]);
    st2.registry.nextIndex = 2n;
    st2.vaults.get(VAULT.toLowerCase()).chainIndex = 7n;
    const db2 = new OnboardD1();
    const wallet2 = mkWallet(st2);
    await withFetch(st2, async () => {
        const cfg = loadConfig(env);
        const [, warns] = await captureWarn(() => onboardingTick(env, cfg, wallet2, db2));
        assert.ok(warns.some((m) => m.includes('已锁定为 7')));
        assert.equal([...db2.rows.values()][0].status, 'indexed'); // 停在后配步
        assert.ok(fnSequence(wallet2).every((_, i) => wallet2.signed[i].to.toLowerCase() !== VAULT.toLowerCase())); // 主金库零广播
    });
});

test('openOutChannel revert "out channel exists" 容错：不炸 tick、状态保留；通道在链可读后继续推进', async () => {
    const st = mkState({ apiChains: [ROW] });
    st.failOn = { fn: 'openOutChannel', message: 'out channel exists' };
    boundBoth(st, 1n, 200n * W);
    const db = new OnboardD1();
    const env = mkEnv();
    const wallet = mkWallet(st);
    await withFetch(st, async () => {
        const cfg = loadConfig(env);
        await onboardingTick(env, cfg, wallet, db); // 不应抛出
        assert.equal([...db.rows.values()][0].status, 'channeled'); // 保留状态等下轮
        assert.deepEqual(fnSequence(wallet), ['registerChain', 'setChainIndex', 'setChainIndex']); // 开通道广播失败未落账

        // 通道实际已存在（他方开出/回执后重读命中）→ 视为已存在继续推进
        st.failOn = null;
        st.bridge.outChannels.set(outKeyOf(1n).toLowerCase(), { authority: RELAYER });
        await onboardingTick(env, cfg, wallet, db); // 出向重读命中 → awaiting_stake
        await onboardingTick(env, cfg, wallet, db); // 押金达标 → active
        assert.equal([...db.rows.values()][0].status, 'active');
        const detail = JSON.parse([...db.rows.values()][0].detail);
        assert.equal(detail.covered, true); // 档案回填
        assert.deepEqual(fnSequence(wallet), ['registerChain', 'setChainIndex', 'setChainIndex']); // 重读命中零新广播
    });
});

test('押金不足：停在 awaiting_stake 并告警，不派生进运行时 config；补足后放行', async () => {
    const st = mkState({ apiChains: [ROW] });
    boundBoth(st, 1n, 100n * W); // < 200
    const db = new OnboardD1();
    const env = mkEnv();
    const wallet = mkWallet(st);
    await withFetch(st, async () => {
        const cfg = loadConfig(env);
        await onboardingTick(env, cfg, wallet, db);
        await onboardingTick(env, cfg, wallet, db);
        assert.equal([...db.rows.values()][0].status, 'awaiting_stake');
        assert.deepEqual(fnSequence(wallet).at(-1), 'openOutChannel'); // 资金动作零广播（最后一步仍是开通道）

        await deriveTopology(env, cfg, db);
        assert.equal(cfg.channels.length, 0); // 未 active 不派生
        assert.equal(cfg.outChannels.length, 0);

        boundBoth(st, 1n, 300n * W);
        await onboardingTick(env, cfg, wallet, db);
        assert.equal([...db.rows.values()][0].status, 'active');
    });
});

test('vars override 优先于派生层：同 chainIndex 的 vars 条目胜出，registry 校准可摘除失踪链', async () => {
    const db = new OnboardD1();
    const varsChannel = { chainIndex: '7', srcToken: '0x' + 'aa'.repeat(20), stplToken: '0x' + 'bb'.repeat(20), srcDecimals: 6, vault: '0x' + 'cc'.repeat(20), covered: false };
    const env = mkEnv({
        CHANNELS: JSON.stringify([varsChannel]),
        SRC_CHAINS: JSON.stringify({ 7: { rpc: 'https://pinned.example', confirmations: 9 } }),
    });
    // D1 档案：7（与 vars 撞链，通道应被丢弃）、8（纯派生）、9（registry 失踪，应被摘除）
    await seedActive(db, 777, '7', { rpc: SPOKE_RPC, vault: VAULT, stplToken: STPL, srcDecimals: 18 });
    await seedActive(db, 888, '8', { rpc: SPOKE_RPC, vault: VAULT, stplToken: STPL, outVault: OUTVAULT, outToken: OUTTOKEN, srcDecimals: 18 });
    await seedActive(db, 999, '9', { rpc: SPOKE_RPC, vault: VAULT, stplToken: STPL, srcDecimals: 18 });

    const st = mkState();
    st.registry.nextIndex = 9n; // 枚举 1..8：只有 7、8 在册（9 失踪 = 已合并/停用）
    st.registry.chains.set('7', { evmChainId: 777n, rpc: SPOKE_RPC, mergedInto: 0n, active: true });
    st.registry.chains.set('8', { evmChainId: 888n, rpc: SPOKE_RPC, mergedInto: 0n, active: true });

    await withFetch(st, async () => {
        const cfg = loadConfig(env);
        const summary = await deriveTopology(env, cfg, db);
        // vars 的 7 号通道原样保留在前（loadConfig 标准补形 rpcUrl/confirmations），派生的 8 号只补 vars 没有的
        assert.equal(cfg.channels.length, 2);
        assert.deepEqual(cfg.channels[0], {
            ...varsChannel,
            rpcUrl: 'https://pinned.example', // vars SRC_CHAINS 钉死的 rpc
            confirmations: 9n,
        });
        assert.equal(cfg.channels[1].chainIndex, '8');
        assert.equal(cfg.channels[1].vault, VAULT);
        // 8 号纯派生（入向+出向），9 号被 registry 校准摘除
        assert.equal(summary.skipped, 1);
        assert.equal(cfg.outChannels.length, 1);
        assert.equal(cfg.outChannels[0].chainIndex, '8');
        assert.equal(cfg.outChannels[0].vault, OUTVAULT);
        // srcChains：7 号走 vars 钉死的 rpc/confirmations（优先级最高），8 号回落 registry rpc
        assert.equal(cfg.srcChains['7'].rpcUrl, 'https://pinned.example');
        assert.equal(cfg.srcChains['7'].confirmations, 9n);
        assert.equal(cfg.srcChains['8'].rpcUrl, SPOKE_RPC);
        assert.equal(cfg.srcChains['8'].confirmations, 3n);
    });
});

test('API_BASE 未配置：onboardingTick 直接返回（零副作用），派生层无档案时也不动 config', async () => {
    const st = mkState({ apiChains: [ROW] });
    const db = new OnboardD1();
    const env = mkEnv({ API_BASE: '' }); // 旧版部署形态
    const wallet = mkWallet(st);
    await withFetch(st, async () => {
        const cfg = loadConfig(env);
        await onboardingTick(env, cfg, wallet, db);
        await deriveTopology(env, cfg, db);
        assert.equal(db.rows.size, 0);
        assert.deepEqual(fnSequence(wallet), []);
        assert.equal(cfg.channels.length, 0);
    });
});
