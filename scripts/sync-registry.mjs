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
// 回填后写回）。hub 链（31339）本无 chain_index 语义；档案缺席/坏 JSON/无该键 →
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
// 2026-10-11 bridge-defee 去费版：质押池（StakePool）契约随合约面整删，白名单去该键。
const WANT = ['BridgeVault', 'OutVault', 'StapleportBridge', 'ChainRegistry', 'StapleportBridgedToken', 'OutToken', 'WBNB', 'PancakeFactory', 'WETH9'];

// 本地链面收窄（2026-10-16 四链定案）：与 Kit 正典常量 LOCAL_STEADY_CHAINS 同值——注册表只收
// hub 31339 + spoke 31338 + 外链测试链 31340 + SP 测试链 31341；all.json 里别的
// 数字桶（31337/78756 等）留档不收录。本仓不引 web-kit，故本地声明同值常量。
// 改口径须与 Kit 常量同步维护。
const LOCAL_STEADY_CHAINS = ['31338', '31339', '31340', '31341'];

// 种子链 meta（C1）：与 Kit SEED_META_CHAINS 同值——不随 all.json
// 部署事实走的链连接元数据：31338（门未过时兜底）、
// 31340/31341（四链拆分新链，无 hh_log 件时兜底 meta-only 行，rpc 端口 8550/8551）。
// 落行时已有实有键行不覆盖。name 用语义显示名（2026-10-16 用户裁定，与 Kit CHAIN_DISPLAY_NAMES 同值）。
const SEED_META_CHAINS = [
    { chainId: '31338', meta: { name: '外链主链31338', rpc: 'http://127.0.0.1:8546', explorer: null } },
    { chainId: '31340', meta: { name: '外链测试链31340', rpc: 'http://127.0.0.1:8550', explorer: null } },
    { chainId: '31341', meta: { name: 'SP测试链31341', rpc: 'http://127.0.0.1:8551', explorer: null } },
];

const chains = {};
for (const [cid, bucket] of Object.entries(all)) {
    if (!LOCAL_STEADY_CHAINS.includes(cid)) continue;
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

// 种子兜底：种子 id 不在 chains 时补 meta-only 行；已有实有键行不覆盖。
for (const seed of SEED_META_CHAINS) {
    if (!chains[seed.chainId]) chains[seed.chainId] = { meta: { ...seed.meta } };
}

writeFileSync(outPath, JSON.stringify({ _comment: '由 sync-registry.mjs 生成——勿手改', chains }, null, 2) + '\n');
console.log(`registry.json 已同步：${Object.keys(chains).length} 条链 ← ${allPath}`);
for (const [cid, e] of Object.entries(chains)) {
    console.log(`  ${cid}: ${Object.keys(e).filter((k) => k !== 'meta').join(', ')}`);
}
