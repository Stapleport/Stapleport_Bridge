// JSON-RPC 薄封装（照 SelfSweep 口径：裸 fetch，不引重型客户端）。
// 2026-09-17 起收编 @stapleport/worker-kit：id 统一 1、错误串统一 JSON.stringify 兜底；
// kit 只做读写通道，本仓签名面留在 lib/tx.js（wallet 才碰私钥）。
//
// 2026-10-11 RPC 备援（RPC 单点缓解）：每链可配多条 rpc（config.js srcChainsRpcs →
// registerRpcGroup 注册）。多条时按**失败轮换**（failover）：优先当前条，抛错（网络/HTTP/
// JSON-RPC error）则顺次试其余，成功后把下标粘到可用条；全败抛最后错误——保持桥「抛错上浮」
// 语义，不吞错、不改变错误类型。只读多源同链数据一致；不做按次轮转（避免滞后节点吞事件）。
// 单条（或未注册）时零开销直通 kit。
import { rpc as kitRpc, hexToBigInt, toHex } from '@stapleport/worker-kit';

// url → { list, i }（i = 当前优先下标）；同组 url 共享同一 list/i
const RPC_GROUPS = new Map();

// 注册一组同链 rpc（去重保序，首条=primary）。多条才启用轮换；重复注册取更长的列表。
export function registerRpcGroup(urls) {
    const list = [...new Set((urls || []).filter(Boolean))];
    if (!list.length) return;
    for (const u of list) {
        const g = RPC_GROUPS.get(u);
        if (!g || g.list.length < list.length) RPC_GROUPS.set(u, { list, i: 0 });
    }
}

async function withFailover(url, call) {
    const g = RPC_GROUPS.get(url);
    if (!g || g.list.length <= 1) return call(url);
    let lastErr;
    for (let n = 0; n < g.list.length; n++) {
        const idx = (g.i + n) % g.list.length;
        try {
            const out = await call(g.list[idx]);
            g.i = idx; // 粘住最近可用条
            return out;
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr;
}

export const rpc = (url, method, params = [], opts = {}) =>
    withFailover(url, (u) => kitRpc(u, method, params, opts));

export const latestBlock = (url, opts) =>
    withFailover(url, async (u) => hexToBigInt(await kitRpc(u, 'eth_blockNumber', [], opts)));

export const callRaw = (url, to, data, opts) =>
    withFailover(url, (u) => kitRpc(u, 'eth_call', [{ to, data }, 'latest'], opts));

// native 余额（本仓版走轮换；注意 tx.js 的 nativeBalance 仍直接 re-export kit 版，不受此覆盖）
export async function nativeBalance(rpcUrl, address) {
    return withFailover(rpcUrl, async (u) => hexToBigInt(await kitRpc(u, 'eth_getBalance', [address, 'latest'])));
}

export { hexToBigInt, toHex };
