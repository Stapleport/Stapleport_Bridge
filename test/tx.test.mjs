// tx.js stub 对拍（本仓无 node --test 套件，本文件为收编后的门禁）：fetch 全 stub 不碰网络。
// 覆盖：dryRun 不广播 / 正常路径返回裸 hash（对外形状不变）/ gasPrecheck 回落路径 /
// 零价兜底。旧版行为基线：三连读(nonce/chainId/gasPrice) + sign + sendRaw，
// kit 收编后签名统一 type:'legacy'、id 统一 1，RPC 序不变（预检先于三连读）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendTx, nativeBalance } from '../src/lib/tx.js';

const ADDR = '0x' + 'ab'.repeat(20);
const TO = '0x' + 'cd'.repeat(20);

function stubWallet() {
    const signed = [];
    return {
        address: ADDR,
        signTransaction: async (tx) => (signed.push(tx), '0xsigned'),
        signed,
    };
}

// fetch stub：按 method 配应答并记录轨迹（node 18+ 的 Response 直返）
function stubFetch({ estimateGas = '0x5208', ethCall = '0x', gasPrice = '0x3b9aca00' } = {}) {
    const calls = [];
    const defaults = {
        eth_getTransactionCount: '0x5',
        eth_chainId: '0x1',
        eth_gasPrice: gasPrice,
        eth_estimateGas: estimateGas,
        eth_call: ethCall,
        eth_sendRawTransaction: '0xhash0',
        eth_getBalance: '0xde0b6b3a7640000',
    };
    const fn = async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push(body);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: defaults[body.method] ?? null }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };
    return { fetchImpl: fn, calls };
}

test('dryRun：不广播、不签名、一个 RPC 都不打，返回 null', async () => {
    const w = stubWallet();
    const { fetchImpl, calls } = stubFetch();
    const orig = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
        const out = await sendTx('https://rpc.example', w, { to: TO, data: '0xdead'.padEnd(76, '0') }, { dryRun: true });
        assert.equal(out, null);
        assert.equal(calls.length, 0);
        assert.equal(w.signed.length, 0);
    } finally {
        globalThis.fetch = orig;
    }
});

test('正常路径：预检 ×1.2 → 三连读 → 签名 → 广播，返回裸 hash（对外形状不变）', async () => {
    const w = stubWallet();
    const { fetchImpl, calls } = stubFetch(); // estimateGas 0x5208=21000 → pre.gas 25200
    const orig = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
        const hash = await sendTx('https://rpc.example', w, { to: TO, data: '0xdeadbeef' });
        assert.equal(hash, '0xhash0');
        // RPC 序：预检(estimateGas) → 三连读 → 广播（三连读从预检前移到签名前，集合不变）
        const methods = calls.map((c) => c.method);
        assert.deepEqual(methods, ['eth_estimateGas', 'eth_getTransactionCount', 'eth_chainId', 'eth_gasPrice', 'eth_sendRawTransaction']);
        assert.equal(calls[0].id, 1); // kit 收编后 id 统一 1（原 Date.now()）
        assert.deepEqual(w.signed[0], {
            type: 'legacy',
            chainId: 1,
            nonce: 5n,
            gas: 25200n,
            gasPrice: 1_000_000_000n,
            to: TO,
            value: 0n,
            data: '0xdeadbeef',
        });
    } finally {
        globalThis.fetch = orig;
    }
});

test('gasPrecheck 回落：估 gas 抛错 → eth_call 模拟通过 → defaultGas 不吃 headroom，仍广播', async () => {
    const w = stubWallet();
    const { fetchImpl, calls } = stubFetch();
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        if (body.method === 'eth_estimateGas') throw new Error('estimate boom');
        return fetchImpl(url, init);
    };
    try {
        const hash = await sendTx('https://rpc.example', w, { to: TO, data: '0xdeadbeef' }, { defaultGas: 600000n });
        assert.equal(hash, '0xhash0');
        assert.equal(w.signed[0].gas, 600000n); // 回落不加 ×1.2
        assert.ok(calls.some((c) => c.method === 'eth_call')); // 模拟甄别跑过
    } finally {
        globalThis.fetch = orig;
    }
});

test('零 baseFee 链：gasPrice 读到 0x0 → 兜底 1 wei；nativeBalance 再导出可用', async () => {
    const w = stubWallet();
    const { fetchImpl } = stubFetch({ gasPrice: '0x0' });
    const orig = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
        await sendTx('https://rpc.example', w, { to: TO, data: '0xdeadbeef' });
        assert.equal(w.signed[0].gasPrice, 1n);
        assert.equal(await nativeBalance('https://rpc.example', ADDR), 10n ** 18n);
    } finally {
        globalThis.fetch = orig;
    }
});
