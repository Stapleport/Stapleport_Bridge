// JSON-RPC 薄封装（照 SelfSweep 口径：裸 fetch，不引重型客户端）
export async function rpc(url, method, params) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`rpc ${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
    return j.result;
}

export const hexToBigInt = (h) => BigInt(h ?? '0x0');
export const toHex = (n) => '0x' + BigInt(n).toString(16);

export async function latestBlock(url) {
    return hexToBigInt(await rpc(url, 'eth_blockNumber', []));
}

// eth_call 只读（返回解码前的原始 data）
export async function callRaw(url, to, data) {
    return rpc(url, 'eth_call', [{ to, data }, 'latest']);
}

// 事件 topic0 里 address 参数的填充形式
export const topicAddr = (addr) => '0x' + '0'.repeat(24) + addr.toLowerCase().slice(2);
