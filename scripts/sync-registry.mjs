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

// 白名单：桥六件套 + 出向件（OutVault/stplN）+ swap 依赖（地址与 meta 进 registry；ABI 走 src/lib/abi.js 不随包）
const WANT = ['BridgeVault', 'OutVault', 'StapleportBridge', 'StakePool', 'ChainRegistry', 'StapleportBridgedToken', 'OutToken', 'WBNB', 'PancakeFactory', 'WETH9'];

const chains = {};
for (const [cid, bucket] of Object.entries(all)) {
    const entry = { meta: { rpc: bucket.__meta?.rpc ?? bucket.meta?.rpc ?? null } };
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
