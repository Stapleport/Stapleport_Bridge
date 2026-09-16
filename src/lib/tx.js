// 交易发送：本地签名 + 裸 eth_sendRawTransaction（照 SelfSweep sweep.js 口径）。
// 显式 legacy gasPrice：零 baseFee 链（联盟链初代）上 EIP-1559 会算出有效价 0 直接 revert；
// eth_estimateGas 在联盟链初代有异常行为的历史（见 NOTES），失败回落 DEFAULT_GAS。
// 估 gas/价格口径已收编 @stapleport/worker-kit precheck.js（本仓口径为正典）：
// gasPrecheck（估 gas → ×1.2 上限；异常回落 defaultGas 不加 headroom + eth_call 模拟甄别）
// + effectiveGasPrice（零 baseFee 链 gasPrice=0 兜底 1 wei）。RPC 序与回落行为逐字段不变。
import { rpc, hexToBigInt } from './rpc.js';
import { gasPrecheck, effectiveGasPrice } from '@stapleport/worker-kit';

export async function sendTx(rpcUrl, wallet, tx, opts = {}) {
    const { dryRun = false, defaultGas = 600000n } = opts;
    if (dryRun) {
        console.log(`[bridge] DRY_RUN ${wallet.address} → ${tx.to} data=${tx.data.slice(0, 74)}…`);
        return null;
    }
    const [nonceHex, chainIdHex, gasPriceHex] = await Promise.all([
        rpc(rpcUrl, 'eth_getTransactionCount', [wallet.address, 'pending']),
        rpc(rpcUrl, 'eth_chainId', []),
        rpc(rpcUrl, 'eth_gasPrice', []),
    ]);
    const nonce = hexToBigInt(nonceHex);
    // chainId 转 number：viem 2.56 legacy 序列化内部做 BigInt(chainId * 2)，传 bigint 会混算
    const chainId = Number(hexToBigInt(chainIdHex));
    const gasPrice = effectiveGasPrice(hexToBigInt(gasPriceHex)); // 零价兜底 1 wei（Kit 同款）

    const pre = await gasPrecheck({
        rpcCall: (method, params) => rpc(rpcUrl, method, params),
        tx: { from: wallet.address, to: tx.to, data: tx.data, value: tx.value ?? '0x0' },
        defaultGas,
        headroomX10: 12n, // 预估值 ×1.2（(gas×120)/100 同值）；回落 defaultGas 不吃 headroom
        skipEstimate: tx.skipEstimate,
    });
    if (pre.source === 'fallback') {
        console.log(`[bridge] estimateGas 失败（${String(pre.estimateError.message).slice(0, 80)}），回落 defaultGas=${defaultGas}`);
        if (pre.simulate?.ok) { // 复现 revert 原因：eth_call 直接打回执数据
            console.log(`[bridge] eth_call 复现结果: ${JSON.stringify(pre.simulate.result).slice(0, 300)}`);
        } else {
            console.log(`[bridge] revert 原因: ${String(pre.simulate.error.message).slice(0, 200)}`);
        }
    }

    const signed = await wallet.signTransaction({
        to: tx.to, data: tx.data, value: tx.value ?? 0n, nonce, chainId, gas: pre.gas, gasPrice,
    });
    return rpc(rpcUrl, 'eth_sendRawTransaction', [signed]);
}

// 余额（native）查询，用于 covered 通道 gas 覆盖预检
export async function nativeBalance(rpcUrl, address) {
    return hexToBigInt(await rpc(rpcUrl, 'eth_getBalance', [address, 'latest']));
}
