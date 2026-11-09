// 过期裁决路径判定：本方向退款指令事件是否存在（禁 claim 门）+ 有界 getLogs。
import { decodeEventLog } from 'viem';
import { vaultAbi, spBridgeAbi, outVaultAbi } from '../lib/abi.js';
import { rpc, latestBlock, toHex } from '../lib/rpc.js';
import {
    DEPOSIT_REFUNDED_TOPIC, RELEASE_SKIPPED_TOPIC, OUT_MINT_REFUNDED_TOPIC, OUT_RELEASE_SKIPPED_TOPIC,
} from './topics.js';

// ---- 领奖门（召回续修二）：过期裁决路径禁 claim ----
// 过期裁决腿复用同一 executeMint/executeRelease/executeOutMint/executeOutRelease 调用——合约过期分支
// 同样置 minted/released/outMinted/outReleased 幂等位，并发本方向退款指令事件。此时 worker 若照常
// claimXxxFee 会把用户本该拿回的 reward 全付 feeRecipient（资金分账错误），且退款腿 _payFeeRefund
// 因 state≠Escrowed revert「fee settled」→ 本金转移回滚、退款永久卡死。故 claim 前以「本方向退款
// 指令事件存在与否」定该 op 终态性质：命中=过期退款路径（禁 claim，退款腿接力），未命中=正常成功。

// 指令事件定位描述：发出链/地址/topic/解码 abi/键匹配（seq 语义随域）。
function instructionEventSpec(cfg, dir, ch, seq) {
    const hub = cfg.hub;
    if (dir === 1) return { label: 'DepositRefunded', rpcUrl: hub.rpcUrl, address: hub.spBridge, topic: DEPOSIT_REFUNDED_TOPIC, abi: spBridgeAbi, keyFn: (a) => a.seq === seq };
    if (dir === 2) return { label: 'ReleaseSkipped', rpcUrl: ch.rpcUrl, address: ch.vault, topic: RELEASE_SKIPPED_TOPIC, abi: vaultAbi, keyFn: (a) => a.outId === seq };
    if (dir === 3) return { label: 'OutMintRefunded', rpcUrl: ch.rpcUrl, address: ch.vault, topic: OUT_MINT_REFUNDED_TOPIC, abi: outVaultAbi, keyFn: (a) => a.inId === seq };
    return { label: 'OutReleaseSkipped', rpcUrl: hub.rpcUrl, address: hub.spBridge, topic: OUT_RELEASE_SKIPPED_TOPIC, abi: spBridgeAbi, keyFn: (a) => a.outBurnId === seq };
}

function matchInstructionLog(spec, log) {
    if (!log?.topics?.length) return false;
    if (String(log.topics[0]).toLowerCase() !== String(spec.topic).toLowerCase()) return false;
    try {
        const ev = decodeEventLog({ abi: spec.abi, data: log.data, topics: log.topics });
        return spec.keyFn(ev.args);
    } catch {
        return false;
    }
}

// 该 op 是否属过期裁决路径（本方向退款指令事件命中）。
// 首选：settle 持有的本次广播回执解码（精确、廉价）；跨轮对账：无回执在手 → getLogs 查该 op 指令事件。
// 无法判定（回执/日志查询失败）→ 返回 true（fail-closed：宁可不 claim，误领不可逆；费滞留 escrow 可补救）。
export async function isAdjudicatedSettled(cfg, dir, ch, seq, txHash) {
    const spec = instructionEventSpec(cfg, dir, ch, seq);
    if (!spec.rpcUrl || !spec.address) return false;
    if (txHash) {
        try {
            const rc = await rpc(spec.rpcUrl, 'eth_getTransactionReceipt', [txHash]);
            const logs = rc?.logs ?? [];
            if (logs.length) return logs.some((log) => matchInstructionLog(spec, log));
            return false; // 回执在且无指令事件 = 正常成功执行
        } catch { /* 回执拉取失败 → 落跨轮日志查询 */ }
    }
    try {
        const logs = await getLogsRanged(spec.rpcUrl, spec.address, spec.topic);
        return logs.some((log) => matchInstructionLog(spec, log));
    } catch {
        return true; // fail-closed
    }
}

// 裁决回退 getLogs（F-019 修订：有界窗口，不再全历史）。
// 旧实现先整段 0x0→latest 一次拉、失败再自 0 起 2k/批续扫：公共 RPC（publicnode）50k 块帽下
// 整段必抛，回落分块在 Sepolia 需数千次请求 → 超时/再抛 → 调用方 fail-closed 误红（零费场景纯空转）。
// 现改为「最近窗口回溯」：自 max(0, tip-lookbackBlocks) 起按 chunkBlocks 分段扫到 tip，窗口内任一块
// 抛错仍向上浮 → 调用方 fail-closed（宁可不 claim，误领不可逆）；终态语义不变，仅扫描下界改。
// 窗口覆盖口径：指令事件随本方向落地交易当轮发射，op 创建→补领奖腿必落在窗口内（relay 逐 tick 处理）；
// 默认 100k 块（Sepolia ~14 天 / 1s 链 ~1.2 天），chunk 10k（低于常见公共 RPC 帽）。
const LOGS_LOOKBACK_BLOCKS = 100_000n;
const LOGS_CHUNK_BLOCKS = 10_000n;

async function getLogsRanged(rpcUrl, address, topic, { lookbackBlocks = LOGS_LOOKBACK_BLOCKS, chunkBlocks = LOGS_CHUNK_BLOCKS } = {}) {
    const query = (fromBlock, toBlock) => rpc(rpcUrl, 'eth_getLogs', [{ address, topics: [topic], fromBlock, toBlock }]);
    const tip = await latestBlock(rpcUrl); // 抛错上浮 → fail-closed
    const from = tip > lookbackBlocks ? tip - lookbackBlocks : 0n;
    const out = [];
    for (let start = from; start <= tip; start += chunkBlocks) {
        const end = start + chunkBlocks - 1n > tip ? tip : start + chunkBlocks - 1n;
        out.push(...(await query(toHex(start), toHex(end))));
    }
    return out;
}
