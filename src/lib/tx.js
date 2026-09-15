// 交易发送：本地签名 + 裸 eth_sendRawTransaction（照 SelfSweep sweep.js 口径）。
// 显式 legacy gasPrice：零 baseFee 链（联盟链初代）上 EIP-1559 会算出有效价 0 直接 revert；
// eth_estimateGas 在联盟链初代有异常行为的历史（见 NOTES），失败回落 DEFAULT_GAS。
import { rpc, hexToBigInt, toHex } from './rpc.js';

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
    const gasPrice = hexToBigInt(gasPriceHex) > 0n ? hexToBigInt(gasPriceHex) : 1n;

    let gas = defaultGas;
    if (!tx.skipEstimate) {
        try {
            gas = hexToBigInt(await rpc(rpcUrl, 'eth_estimateGas', [{
                from: wallet.address, to: tx.to, data: tx.data, value: tx.value ?? '0x0',
            }]));
            gas = (gas * 120n) / 100n; // 20% 余量（HelperWorker execute.js 同款）
        } catch (e) {
            console.log(`[bridge] estimateGas 失败（${String(e.message).slice(0, 80)}），回落 defaultGas=${defaultGas}`);
            try { // 复现 revert 原因：eth_call 直接打回执数据
                const r = await rpc(rpcUrl, 'eth_call', [{ from: wallet.address, to: tx.to, data: tx.data, value: tx.value ?? '0x0' }, 'latest']);
                console.log(`[bridge] eth_call 复现结果: ${JSON.stringify(r).slice(0, 300)}`);
            } catch (e2) {
                console.log(`[bridge] revert 原因: ${String(e2.message).slice(0, 200)}`);
            }
        }
    }

    const signed = await wallet.signTransaction({
        to: tx.to, data: tx.data, value: tx.value ?? 0n, nonce, chainId, gas, gasPrice,
    });
    return rpc(rpcUrl, 'eth_sendRawTransaction', [signed]);
}

// 余额（native）查询，用于 covered 通道 gas 覆盖预检
export async function nativeBalance(rpcUrl, address) {
    return hexToBigInt(await rpc(rpcUrl, 'eth_getBalance', [address, 'latest']));
}
