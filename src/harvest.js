// harvest 回血：源链 Vault 攒的手续费 → 经 swap 换 native（tip 给本 relayer + 协议费）。
// 「第三方链的手续费折 gas 必须覆盖中继成本」的兑现端：covered 通道建议把
// HARVEST_THRESHOLD_NATIVE 设为若干笔 gas 的估值，攒够再换，摊薄 gas。
import { encodeFunctionData, decodeFunctionResult } from 'viem';
import { vaultAbi, factoryAbi, pairAbi } from './lib/abi.js';
import { callRaw, rpc } from './lib/rpc.js';
import { sendTx } from './lib/tx.js';
import { notify } from './notify.js';

export async function harvestAll(env, cfg, wallet, db) {
    if (cfg.hub.rpcUrl === null) return;
    for (const ch of cfg.channels) {
        const srcRpc = cfg.srcChains[String(ch.chainIndex)]?.rpcUrl;
        if (!srcRpc || !ch.vault) continue;
        try {
            const feeRaw = await callRaw(srcRpc, ch.vault,
                encodeFunctionData({ abi: vaultAbi, functionName: 'pendingFee', args: [ch.srcToken] }));
            const fee = decodeFunctionResult({ abi: vaultAbi, functionName: 'pendingFee', data: feeRaw });
            if (fee === 0n) continue;

            const quote = await quoteNativeIn(srcRpc, ch, fee);
            if (quote === null) {
                console.log(`[bridge] harvest ${ch.chainIndex}: 本链无 srcToken/wnative 池，跳过（可走 claimFee 人工归集）`);
                continue;
            }
            if (quote < cfg.harvestThreshold) continue;

            const minOut = (quote * (10000n - cfg.harvestSlipBps)) / 10000n;
            const data = encodeFunctionData({
                abi: vaultAbi, functionName: 'harvest', args: [ch.srcToken, minOut],
            });
            const tx = await sendTx(srcRpc, wallet, { to: ch.vault, data }, cfg);
            if (tx) {
                await notify(env, { event: 'harvest', channel: ch.chainIndex, feeIn: String(fee), quoteNative: String(quote), tx });
            }
        } catch (e) {
            console.log(`[bridge] harvest chainIndex=${ch.chainIndex} 异常：${String(e.message).slice(0, 120)}`);
        }
    }
}

// pendingFee 折 native 估值（pair 现价）；无池返回 null
async function quoteNativeIn(srcRpc, ch, fee) {
    const factoryRaw = await callRaw(srcRpc, ch.vault,
        encodeFunctionData({ abi: vaultAbi, functionName: 'swapFactory' }));
    // viem 单返回值 decode 直接给值本身（非数组），不可解构
    const factory = decodeFunctionResult({ abi: vaultAbi, functionName: 'swapFactory', data: factoryRaw });
    const zero = '0x0000000000000000000000000000000000000000';
    if (factory === zero) return null;
    const wnativeRaw = await callRaw(srcRpc, ch.vault,
        encodeFunctionData({ abi: vaultAbi, functionName: 'wnative' }));
    const wnative = decodeFunctionResult({ abi: vaultAbi, functionName: 'wnative', data: wnativeRaw });

    const pairRaw = await callRaw(srcRpc, factory,
        encodeFunctionData({ abi: factoryAbi, functionName: 'getPair', args: [ch.srcToken, wnative] }));
    const pair = decodeFunctionResult({ abi: factoryAbi, functionName: 'getPair', data: pairRaw });
    if (pair === '0x0000000000000000000000000000000000000000') return null;

    const [r0, r1] = decodeFunctionResult({
        abi: pairAbi, functionName: 'getReserves',
        data: await callRaw(srcRpc, pair, encodeFunctionData({ abi: pairAbi, functionName: 'getReserves' })),
    });
    const t0 = decodeFunctionResult({
        abi: pairAbi, functionName: 'token0',
        data: await callRaw(srcRpc, pair, encodeFunctionData({ abi: pairAbi, functionName: 'token0' })),
    });
    const [rSrc, rNat] = t0.toLowerCase() === String(ch.srcToken).toLowerCase() ? [r0, r1] : [r1, r0];
    if (rSrc === 0n) return null;
    return (fee * rNat) / rSrc;
}
