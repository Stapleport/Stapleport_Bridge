// 从合约仓 deployments/all.json 同步桥相关合约地址与裁剪版 ABI 到本仓 registry.json。
// 用法：node scripts/sync-registry.mjs [all.json 路径，缺省 ../../Stapleport_hardhat/deployments/all.json（bridge/ 组内两跳；2026-09-15 自 web/ 挪组后少一层）]
// 只搬运白名单合约，ABI 只保留 worker 用到的条目——包体与攻击面都最小化。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const allPath = resolve(here, '..', process.argv[2] || '../../Stapleport_hardhat/deployments/all.json');
const outPath = join(here, '..', 'registry.json');

const all = JSON.parse(readFileSync(allPath, 'utf8'));

// chain_index 补数（2026-09-28，与 Web 版 Stapleport_Web_bridge/js/registry.json 同口径）：
// spoke 链在 hub ChainRegistry 的链索引不是 all.json 部署事实，留痕在 Token state 档
// state-<chainId>.json 的 chainIndex 键（register-31338-hub.js 颁发、set-chain-index-31338.js
// 回填后写回）。hub 链（31339/78753）本无 chain_index 语义；档案缺席/坏 JSON/无该键 →
// 不写该字段。绝不编造数字。注：relayer 现行配置链路（src/config.js）的 chainIndex 取自
// vars 通道档案与链上 ChainRegistry 枚举，本字段目前只作两仓 registry 事实对齐。
const TOKEN_STATE_DIR = resolve(here, '..', '..', '..', 'Stapleport_hardhat', 'scripts', 'Token');
const chainIndexOf = (cid) => {
    try {
        const v = JSON.parse(readFileSync(join(TOKEN_STATE_DIR, `state-${cid}.json`), 'utf8'))?.chainIndex;
        return v !== undefined && v !== null && String(v).trim() !== '' ? String(v) : null;
    } catch { return null; }
};

// 白名单：桥六件套 + 出向件（OutVault/spN）+ swap 依赖（地址与 meta 进 registry；ABI 走 src/lib/abi.js 不随包）
const WANT = ['BridgeVault', 'OutVault', 'StapleportBridge', 'StakePool', 'ChainRegistry', 'StapleportBridgedToken', 'OutToken', 'WBNB', 'PancakeFactory', 'WETH9'];

const chains = {};
for (const [cid, bucket] of Object.entries(all)) {
    const entry = { meta: { rpc: bucket.__meta?.rpc ?? bucket.meta?.rpc ?? null } };
    const idx = chainIndexOf(cid);
    if (idx) entry.chain_index = idx;
    let hit = false;
    for (const name of WANT) {
        const c = bucket[name];
        if (c?.address) {
            entry[name] = { address: c.address, p_address: c.p_address ?? c.address };
            hit = true;
        }
    }
    if (hit) chains[cid] = entry;
}

// meta.rpc 补充：all.json 的 network.url（hh_log 落盘里有）
for (const [cid, bucket] of Object.entries(all)) {
    if (!chains[cid]) continue;
    const any = Object.values(bucket).find((c) => c?.network?.url);
    if (any?.network?.url && !chains[cid].meta.rpc) chains[cid].meta.rpc = any.network.url;
}

writeFileSync(outPath, JSON.stringify({ _comment: '由 sync-registry.mjs 生成——勿手改', chains }, null, 2) + '\n');
console.log(`registry.json 已同步：${Object.keys(chains).length} 条链 ← ${allPath}`);
for (const [cid, e] of Object.entries(chains)) {
    console.log(`  ${cid}: ${Object.keys(e).filter((k) => k !== 'meta').join(', ')}`);
}
