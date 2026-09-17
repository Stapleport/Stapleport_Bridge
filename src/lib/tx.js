// 交易发送：本地签名 + 裸 eth_sendRawTransaction（照 SelfSweep sweep.js 口径）。
// 显式 legacy gasPrice：零 baseFee 链（联盟链初代）上 EIP-1559 会算出有效价 0 直接 revert；
// eth_estimateGas 在联盟链初代有异常行为的历史（见 NOTES），失败回落 DEFAULT_GAS。
// 估 gas/价格口径已收编 @stapleport/worker-kit precheck.js（本仓口径为正典）：
// gasPrecheck（估 gas → ×1.2 上限；异常回落 defaultGas 不加 headroom + eth_call 模拟甄别）
// + effectiveGasPrice（零 baseFee 链 gasPrice=0 兜底 1 wei）。
// 2026-09-17 起三连读+签名+广播骨架收编 kit broadcastLegacy（nonce/chainId/gasPrice 三读
// 在签名前补齐；返回裸 hash 的对外形状不变，bridge 原「抛错上浮」语义保持：不开自愈）。
import { gasPrecheck, broadcastLegacy, nativeBalance } from '@stapleport/worker-kit';
import { rpc } from './rpc.js';

export async function sendTx(rpcUrl, wallet, tx, opts = {}) {
    const { dryRun = false, defaultGas = 600000n } = opts;
    if (dryRun) {
        console.log(`[bridge] DRY_RUN ${wallet.address} → ${tx.to} data=${tx.data.slice(0, 74)}…`);
        return null;
    }
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

    const { txHash } = await broadcastLegacy({
        rpcCall: (method, params) => rpc(rpcUrl, method, params),
        wallet,
        // nonce/chainId/gasPrice 不给 = kit 内补三连读（与本仓原 Promise.all 三读同集）；
        // gas 用预检结果（估中 ×1.2 / 回落 defaultGas）
        tx: { to: tx.to, data: tx.data, value: tx.value ?? 0n, gas: pre.gas },
    });
    return txHash;
}

// 余额（native）查询，用于 covered 通道 gas 覆盖预检（kit 同款再导出）
export { nativeBalance };
