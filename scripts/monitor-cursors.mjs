// TEST relayer 健康 / 游标滞后 / 燃料余额巡检探针（只读）。
//
// 用法（在 Stapleport_Bridge/Stapleport_Bridge/ 下）：
//   node scripts/monitor-cursors.mjs \
//     [--url http://127.0.0.1:8787] \        # worker /health 地址
//     [--db stapleport-bridge-db-test] \     # 传则查 D1（cursors/ops），省略只查 /health
//     [--remote] \                           # D1 查询走远端（默认 --local）
//     [--config wrangler.test.jsonc] \       # wrangler 配置档
//     [--hub-rpc https://rpc-test.stapleport.com] \  # 'hub' 游标的链高来源（默认取 /health.hub.rpcUrl）
//     [--rpcs '{"1":"http://127.0.0.1:8546"}'] \     # 'src:<idx>' 游标的 rpc 映射
//     [--lag-warn 100] [--json]
//
// 输出：/health 摘要；relayer 在各链的 native 余额（燃料巡检）；D1 游标 (head-cursor) 滞后；
// ops 表 pending/stuck 计数。任一链游标滞后 > lag-warn 或存在 stuck op → 退出码 1（供 cron/CI 捕获）。
//
// 口径：游标 chain_id 为 'hub' 或 'src:<chainIndex>'（见 relay.js）；rpc 解析顺序=
// 显式 --hub-rpc/--rpcs > /health.hub.rpcUrl（仅 hub）；解析不到即跳过滞后计算（只报 cursor 值）。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const URL_ = flag('--url', 'http://127.0.0.1:8787');
const DB = flag('--db', '');
const REMOTE = args.includes('--remote');
const CONFIG = flag('--config', 'wrangler.test.jsonc');
const HUB_RPC = flag('--hub-rpc', '');
const RPCS = JSON.parse(flag('--rpcs', '{}'));
const LAG_WARN = Number(flag('--lag-warn', '100'));
const AS_JSON = args.includes('--json');

const warn = [];
const out = { health: null, balances: [], cursors: [], ops: null, warnings: [] };

async function rpcCall(rpcUrl, method, params = []) {
    const res = await fetch(rpcUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    return j.result;
}
const hexToBig = (h) => BigInt(h === '0x' || h == null ? '0x0' : h);

// ---------- 1. /health ----------
try {
    const res = await fetch(`${URL_.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(8000) });
    out.health = await res.json();
} catch (e) {
    out.warnings.push(`/health 不可达：${String(e.message).slice(0, 120)}`);
}
const relayer = out.health?.relayer || null;
const hubRpcEffective = HUB_RPC || out.health?.hub?.rpcUrl || null;

// ---------- 2. 燃料余额巡检（各已知链上 relayer native）----------
const rpcsToCheck = new Map();
if (hubRpcEffective) rpcsToCheck.set('hub', hubRpcEffective);
for (const [k, v] of Object.entries(RPCS)) rpcsToCheck.set(String(k), v);
if (relayer) {
    for (const [label, rpcUrl] of rpcsToCheck) {
        try {
            const bal = hexToBig(await rpcCall(rpcUrl, 'eth_getBalance', [relayer, 'latest']));
            out.balances.push({ chain: label, rpc: rpcUrl, wei: bal.toString() });
        } catch (e) {
            out.balances.push({ chain: label, rpc: rpcUrl, error: String(e.message).slice(0, 120) });
        }
    }
} else {
    out.warnings.push('无 relayer 地址（/health 未配置 key），跳过余额巡检');
}

// ---------- 3. D1 cursors / ops（可选）----------
if (DB) {
    const runD1 = (sql) => {
        const cli = join(ROOT, 'node_modules/.bin/wrangler');
        const cmdArgs = ['d1', 'execute', DB, REMOTE ? '--remote' : '--local', '--json', '--command', sql];
        if (existsSync(join(ROOT, CONFIG))) cmdArgs.push('-c', CONFIG);
        const raw = execFileSync(cli, cmdArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const parsed = JSON.parse(raw);
        // wrangler --json 形状：[{ results: [...], success, meta }]
        return (parsed[0]?.results) ?? [];
    };
    try {
        const rows = runD1('select chain_id, name, last_block from cursors order by chain_id, name');
        for (const r of rows) {
            const rpcUrl = r.chain_id === 'hub' ? hubRpcEffective
                : (RPCS[String(r.chain_id).replace(/^src:/, '')] || null);
            let head = null, lag = null, err = null;
            if (rpcUrl) {
                try { head = hexToBig(await rpcCall(rpcUrl, 'eth_blockNumber')); lag = Number(head - BigInt(r.last_block)); }
                catch (e) { err = String(e.message).slice(0, 120); }
            }
            out.cursors.push({ chain_id: r.chain_id, name: r.name, last_block: r.last_block, head: head?.toString() ?? null, lag, err });
            if (lag !== null && lag > LAG_WARN) out.warnings.push(`游标滞后 ${r.chain_id}/${r.name} lag=${lag} > ${LAG_WARN}`);
        }
        const opRows = runD1("select direction, status, count(*) n, max(attempts) max_attempts from ops group by direction, status");
        out.ops = opRows;
        for (const o of opRows) {
            if (o.status === 'pending' && Number(o.max_attempts) >= 10) out.warnings.push(`stuck op：${o.direction} pending n=${o.n} max_attempts=${o.max_attempts}`);
        }
    } catch (e) {
        const detail = e.stderr ? String(e.stderr).slice(0, 300) : String(e.message).slice(0, 200);
        out.warnings.push(`D1 查询失败（--db ${DB}）：${detail}`);
    }
} else {
    out.warnings.push('未传 --db，跳过 D1 游标/ops 查询');
}

// ---------- 输出 ----------
if (AS_JSON) {
    console.log(JSON.stringify(out, null, 2));
} else {
    const h = out.health;
    console.log(`[monitor] /health ${h ? `ok=${h.ok} configured=${h.configured} relayer=${h.relayer ?? 'null'} dryRun=${h.dryRun}` : '不可达'}`);
    if (h) console.log(`[monitor] hub=${h.hub?.chainId ?? '?'} ${h.hub?.rpcUrl ?? '?'} 通道=${h.channels?.length ?? '?'} 出向=${h.outChannels?.length ?? '?'}`);
    if (out.balances.length) {
        console.log('[monitor] 燃料巡检：');
        for (const b of out.balances) console.log(`  ${b.chain}: ${b.error ? `ERR ${b.error}` : `${b.wei} wei (${b.rpc})`}`);
    }
    if (out.cursors.length) {
        console.log('[monitor] 游标：');
        for (const c of out.cursors) console.log(`  ${c.chain_id}/${c.name}: cursor=${c.last_block} head=${c.head ?? '-'} lag=${c.lag ?? '-'}${c.err ? ` err=${c.err}` : ''}`);
    }
    if (out.ops) {
        console.log('[monitor] ops：');
        for (const o of out.ops) console.log(`  ${o.direction}/${o.status}: n=${o.n} max_attempts=${o.max_attempts}`);
    }
    for (const w of out.warnings) console.log(`[monitor][warn] ${w}`);
}
process.exit(out.warnings.some((w) => /游标滞后|stuck op/.test(w)) ? 1 : 0);
