// 双向中继主循环。
//
// 正向：源链 Vault.Deposit(seq) → stapleport StapleportBridge.executeMint（仅通道 authority 可调）
// 反向：stapleport StapleportBridge.BurnRequest(seq) → 源链 Vault.executeRelease（outId=seq，跨链唯一）
//
// 可靠性设计：
// - 游标存 D1（cursors 表），首轮只落基线不处理历史（照 SelfSweep monitor 口径）
// - ops 表 INSERT OR IGNORE 抢占 + 合约层幂等（minted/released）双保险：
//   D1 丢失最多多烧几笔被合约拦下的空交易，绝不双铸/双放
// - 广播后不强等回执：op 保持 pending，下一轮先用链上幂等位对账（minted/released）
//   命中即 done；未命中且 attempts 未超限则重发
import { encodeFunctionData, decodeEventLog, decodeFunctionResult, keccak256, encodeAbiParameters, parseAbiItem, getEventSelector } from 'viem';
import { vaultAbi, spBridgeAbi, outVaultAbi, DEPOSIT_EVENT, BURN_EVENT, LOCKOUT_EVENT, BURNOUT_EVENT, DEPOSIT_REFUNDED_EVENT, RELEASE_SKIPPED_EVENT, OUT_MINT_REFUNDED_EVENT, OUT_RELEASE_SKIPPED_EVENT } from './lib/abi.js';
import { rpc, callRaw, latestBlock, toHex } from './lib/rpc.js';
import { sendTx } from './lib/tx.js';
import { getCursor, setCursor, claimOp, finishOp, failOp, setFeeState, bumpFeeAttempts, bumpStuckCount } from './lib/store.js';
import {
    fetchGas, oracleFacts, admitCheck, sweepCheck, estimateLegAWei, readPadFloor, readFees, readLegB,
} from './lib/fee.js';
import { to18, from18 } from './config.js';
import { notify } from './notify.js';
// 2026-09-23 起收编 WorkerKit 单源（原仓内常量退役）
import { ZERO_ADDRESS } from '@stapleport/worker-kit';

export { ZERO_ADDRESS };

// channelKey 与合约同构：keccak256(abi.encode(chainIndex, srcToken))
export const channelKeyOf = (chainIndex, srcToken) =>
    keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [BigInt(chainIndex), srcToken]));

// 出向通道键与合约同构：(chainIndex, address(0))——native 无 srcToken
export const outKeyOf = (chainIndex) => channelKeyOf(chainIndex, ZERO_ADDRESS);

const DEPOSIT_TOPIC = getEventSelector(parseAbiItem(`event ${DEPOSIT_EVENT}`));
const BURN_TOPIC = getEventSelector(parseAbiItem(`event ${BURN_EVENT}`));
const LOCKOUT_TOPIC = getEventSelector(parseAbiItem(`event ${LOCKOUT_EVENT}`));
const BURNOUT_TOPIC = getEventSelector(parseAbiItem(`event ${BURNOUT_EVENT}`));

// ================= 预付 gas 费率面（bridge-fee-design §3 / §3.4）=================
// 费率乘数/常数单一出处 = kit（经 lib/fee.js 再导出）；本文件不出现 ×10/×5 字面量。
// 四向 dir：1=deposit/executeMint、2=requestBurn/executeRelease、3=lockOut/executeOutMint、
// 4=requestOutBurn/executeOutRelease。费 escrow 落链见设计稿 §1.2。

// 费率域描述（escrow 落链/键 + A/B 链口径）。aRpc/bRpc 供 oracle 归一，aChainId/bChainId 取
// evm chainId（缺失 → null → oracle 落 FALLBACK_PRICE）。stability hint：hub=SPUSD（稳定）。
function feeDomain(cfg, dir, ch, erc20) {
    const hub = cfg.hub;
    const src = cfg.srcChains[String(ch?.chainIndex)];
    if (dir === 1) {
        return {
            rpcUrl: ch.rpcUrl ?? src?.rpcUrl, to: ch.vault, abi: vaultAbi,
            padFn: 'padFloorDir1', feesFn: 'depositFees', legBFn: 'legBDir1',
            aChainId: ch.evmChainId ?? null, aStable: false,
            bChainId: hub.chainId, bStable: true,
        };
    }
    if (dir === 2) {
        return {
            rpcUrl: hub.rpcUrl, to: hub.spBridge, abi: spBridgeAbi,
            padFn: 'padFloorDir2', feesFn: 'burnFees', legBFn: 'legBDir2',
            aChainId: hub.chainId, aStable: true,
            bChainId: ch?.evmChainId ?? null, bStable: false,
        };
    }
    if (dir === 3) {
        return {
            rpcUrl: hub.rpcUrl, to: hub.spBridge, abi: spBridgeAbi,
            padFn: 'padFloorDir3', feesFn: erc20 ? 'outLockFeesErc20' : 'outLockFees', legBFn: 'legBDir3',
            aChainId: hub.chainId, aStable: true,
            bChainId: ch?.evmChainId ?? null, bStable: false,
        };
    }
    return {
        rpcUrl: ch?.rpcUrl ?? src?.rpcUrl, to: ch?.vault, abi: outVaultAbi,
        padFn: 'padFloorDir4', feesFn: 'outBurnFees', legBFn: 'legBDir4',
        aChainId: ch?.evmChainId ?? null, aStable: false,
        bChainId: hub.chainId, bStable: true,
    };
}

// 现读链上 Fees/padFloor + oracle 重估（每次调用现估，无跨 tick 缓存）。读失败 → null（放行现役行为）。
async function evaluateFee(env, cfg, dir, ch, erc20, seq) {
    const dom = feeDomain(cfg, dir, ch, erc20);
    if (!dom.rpcUrl || !dom.to) return null;
    try {
        const fees = await readFees(callRaw, dom.rpcUrl, dom.to, dom.abi, dom.feesFn, [seq]);
        if (fees.state !== 0) return { terminal: true, fees }; // 非 Escrowed：已退款/已领奖（终态）
        const [padFloorWei, legBWei, gasA, gasB] = await Promise.all([
            readPadFloor(callRaw, dom.rpcUrl, dom.to, dom.abi, dom.padFn),
            readLegB(callRaw, dom.rpcUrl, dom.to, dom.abi, dom.legBFn),
            fetchGas(cfg.oracleBase, dom.aChainId),
            fetchGas(cfg.oracleBase, dom.bChainId),
        ]);
        const a = oracleFacts(gasA, { stableHint: dom.aStable });
        const b = oracleFacts(gasB, { stableHint: dom.bStable });
        const paidWei = fees.pad + fees.reward;
        const adm = admitCheck({
            dir, paidWei, padFloorWei,
            gasPriceWeiB: b.gasPriceWei, priceBScaled: b.priceScaled, priceAScaled: a.priceScaled,
        });
        const legAWei = estimateLegAWei({ padFloorWei, legBWei });
        const sw = sweepCheck({ paidWei, legAWei, legBWei });
        return {
            fees, padFloorWei, legBWei, paidWei,
            admit: adm.admit, rewardWei: adm.rewardWei, sweep: sw.sweep, costWei: sw.costWei,
        };
    } catch (e) {
        console.log(`[bridge] fee 评估异常 dir=${dir} seq=${seq}：${String(e.message).slice(0, 120)}（放行现役行为）`);
        return null;
    }
}

// 费率闸门：读现状 + 现估 → 决策。返回 action ∈
//   proceed（准入达标 / 无法评估，放行广播正常执行腿）
//   insufficient（未达标：置 fee_state='insufficient'，不广播不计 attempts）
//   adjudicate（过 deadline+缓冲：置 'admit'，广播过期裁决腿——复用同执行编码，合约过期分支收口）
//   never_sweep（过期且垃圾 paid<两腿成本：置 'never_sweep' 终态，跳过）
//   terminal（Fees state≠Escrowed：已终态）
async function feeAction(env, cfg, db, { dir, ch, erc20 = false, seq, buyDeadlineSecs, direction, key }) {
    const nowSec = Math.floor(Date.now() / 1000);
    const dl = Number(buyDeadlineSecs ?? 0);
    const pastDeadline = dl > 0 && nowSec > dl + cfg.adjudicateBufferSec;
    const ev = await evaluateFee(env, cfg, dir, ch, erc20, seq);
    if (!ev) return { action: 'proceed' };
    if (ev.terminal) return { action: 'terminal', ev };
    if (pastDeadline) {
        if (!ev.sweep) {
            await setFeeState(db, direction, key, 'never_sweep');
            return { action: 'never_sweep', ev };
        }
        await setFeeState(db, direction, key, 'admit');
        return { action: 'adjudicate', ev };
    }
    if (!ev.admit) {
        await setFeeState(db, direction, key, 'insufficient');
        await bumpFeeAttempts(db, direction, key);
        return { action: 'insufficient', ev };
    }
    await setFeeState(db, direction, key, 'admit');
    return { action: 'proceed', ev };
}

// ---- 领奖腿（§3.4 新 direction ×5；幂等 = claimOp + Fees getter state==2）----

// 领奖描述（域/编码/幂等视图）。
function claimSpec(cfg, dir, ch, erc20, seq) {
    const hub = cfg.hub;
    if (dir === 1) {
        return {
            direction: 'fee_claim_mint', key: `${ch.chainIndex}:${seq}`, chainIndex: String(ch.chainIndex),
            rpcUrl: ch.rpcUrl, to: ch.vault, abi: vaultAbi, fn: 'claimDepositFee', args: [seq],
            viewFn: 'depositFees', viewArgs: [seq],
            payload: { dir: 1, chainIndex: String(ch.chainIndex), seq: String(seq) },
        };
    }
    if (dir === 2) {
        return {
            direction: 'fee_claim_release', key: String(seq), chainIndex: String(ch?.chainIndex ?? ''),
            rpcUrl: hub.rpcUrl, to: hub.spBridge, abi: spBridgeAbi, fn: 'claimBurnFee', args: [seq],
            viewFn: 'burnFees', viewArgs: [seq],
            payload: { dir: 2, seq: String(seq) },
        };
    }
    if (dir === 3) {
        return {
            direction: erc20 ? 'fee_claim_out_mint_e20' : 'fee_claim_out_mint', key: `${ch.chainIndex}:${seq}`,
            chainIndex: String(ch.chainIndex),
            rpcUrl: hub.rpcUrl, to: hub.spBridge, abi: spBridgeAbi,
            fn: erc20 ? 'claimOutLockFeeErc20' : 'claimOutLockFee', args: [seq],
            viewFn: erc20 ? 'outLockFeesErc20' : 'outLockFees', viewArgs: [seq],
            payload: { dir: 3, erc20: !!erc20, chainIndex: String(ch.chainIndex), seq: String(seq) },
        };
    }
    return {
        direction: 'fee_claim_out_release', key: `${ch.chainIndex}:${seq}`, chainIndex: String(ch.chainIndex),
        rpcUrl: ch.rpcUrl, to: ch.vault, abi: outVaultAbi, fn: 'claimOutBurnFee', args: [seq],
        viewFn: 'outBurnFees', viewArgs: [seq],
        payload: { dir: 4, chainIndex: String(ch.chainIndex), seq: String(seq) },
    };
}

// 单次领奖尝试（不做 claimOp 抢占——ensureClaim/retry 各自决定）。导出供单测（卡死停试腿）。
export async function attemptClaim(env, cfg, wallet, db, spec) {
    if (cfg.dryRun) {
        await finishOp(db, spec.direction, spec.key, 'dry-run');
        return;
    }
    const data = encodeFunctionData({ abi: spec.abi, functionName: spec.fn, args: spec.args });
    try {
        const txHash = await sendTx(spec.rpcUrl, wallet, { to: spec.to, data }, cfg);
        if (txHash == null) {
            // 预估失败跳过（tx.js 统一收口，发前预估门）：连续失败计次，达阈值写卡死终态停试（追派二）
            const n = await bumpStuckCount(db, spec.direction, spec.key);
            if (n >= (cfg.stuckThreshold ?? 5)) {
                await setFeeState(db, spec.direction, spec.key, 'claim_stuck');
                await notify(env, { event: `${spec.direction}_stuck`, chainIndex: spec.chainIndex, key: spec.key, note: 'estimate-fail >= threshold, terminal stop' });
            }
            return;
        }
        console.log(`[bridge] ${spec.fn} 广播: ${txHash}`);
        await ctxWait(env, claimSettle(env, cfg, db, spec, txHash));
    } catch (e) {
        console.log(`[bridge] ${spec.fn} 领奖腿异常 key=${spec.key}: ${String(e.message).slice(0, 200)}`);
        const exhausted = await failOp(db, spec.direction, spec.key, e, cfg.maxAttempts);
        if (exhausted) {
            await notify(env, { event: `${spec.direction}_stuck`, chainIndex: spec.chainIndex, key: spec.key, error: String(e.message).slice(0, 200) });
        }
    }
}

// 广播后短轮询幂等位（Fees state==2；拿不到留给下一轮领奖重试）。
function claimSettle(env, cfg, db, spec, txHash) {
    return (async () => {
        if (txHash == null) return;
        for (let i = 0; i < 3; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
                const st = await readFees(callRaw, spec.rpcUrl, spec.to, spec.abi, spec.viewFn, spec.viewArgs);
                if (st.state === 2) {
                    await finishOp(db, spec.direction, spec.key, txHash ?? 'confirmed');
                    await notify(env, { event: `${spec.direction}_sent`, key: spec.key, tx: txHash });
                    return;
                }
            } catch { /* 读失败留待下轮 */ }
        }
        await notify(env, { event: `${spec.direction}_broadcast`, key: spec.key, tx: txHash, note: '回执未确认，下轮对账' });
    })();
}

// 估 gas 连败计次（F-018b；借 fee_attempts 列，独立于 ops.attempts）：连败 ≥ stuckThreshold 写卡死
// 终态 fee_state='<direction>_stuck' + 告警一次，重试循环按该终态跳过本行（口径同 refund/claim 先例）。
async function noteEstimateFail(env, cfg, db, { direction, key, chainIndex, seq }) {
    const n = await bumpStuckCount(db, direction, key);
    if (n >= (cfg.stuckThreshold ?? 5)) {
        await setFeeState(db, direction, key, `${direction}_stuck`);
        await notify(env, { event: `${direction}_stuck`, channel: chainIndex, seq, note: 'estimate-fail >= threshold, terminal stop' });
    }
}

// ---- 领奖门（召回续修二）：过期裁决路径禁 claim ----
// 过期裁决腿复用同一 executeMint/executeRelease/executeOutMint/executeOutRelease 调用——合约过期分支
// 同样置 minted/released/outMinted/outReleased 幂等位，并发本方向退款指令事件。此时 worker 若照常
// claimXxxFee 会把用户本该拿回的 reward 全付 feeRecipient（资金分账错误），且退款腿 _payFeeRefund
// 因 state≠Escrowed revert「fee settled」→ 本金转移回滚、退款永久卡死。故 claim 前以「本方向退款
// 指令事件存在与否」定该 op 终态性质：命中=过期退款路径（禁 claim，退款腿接力），未命中=正常成功。
const DEPOSIT_REFUNDED_TOPIC = getEventSelector(parseAbiItem(`event ${DEPOSIT_REFUNDED_EVENT}`));
const RELEASE_SKIPPED_TOPIC = getEventSelector(parseAbiItem(`event ${RELEASE_SKIPPED_EVENT}`));
const OUT_MINT_REFUNDED_TOPIC = getEventSelector(parseAbiItem(`event ${OUT_MINT_REFUNDED_EVENT}`));
const OUT_RELEASE_SKIPPED_TOPIC = getEventSelector(parseAbiItem(`event ${OUT_RELEASE_SKIPPED_EVENT}`));

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

// 裁决回退全链 getLogs（F-019）：先整段 0x0→latest 一次拉；RPC 限区间报错时分块续扫（块 2k/批，
// getLogsRanged 先例：Stapleport_Web_kit/src/ops/participationBoard.js）。任一块抛错向上浮 → 调用方
// fail-closed（宁可不 claim）；终态语义不变，仅扫描方式改。
async function getLogsRanged(rpcUrl, address, topic, chunkBlocks = 2000n) {
    const query = (fromBlock, toBlock) => rpc(rpcUrl, 'eth_getLogs', [{ address, topics: [topic], fromBlock, toBlock }]);
    try {
        return await query('0x0', 'latest');
    } catch {
        const tip = await latestBlock(rpcUrl); // 抛错同样上浮 → fail-closed
        const out = [];
        for (let start = 0n; start <= tip; start += chunkBlocks) {
            const end = start + chunkBlocks - 1n > tip ? tip : start + chunkBlocks - 1n;
            out.push(...(await query(toHex(start), toHex(end))));
        }
        return out;
    }
}

// 成功幂等位确认 → 触发本域领奖腿（幂等 = claimOp 抢占 + Fees state==2 预查）。异常吞并，不拖垮已 done 主 op。
export async function ensureClaim(env, cfg, wallet, db, { dir, ch, erc20 = false, seq, txHash }) {
    try {
        // 门：过期裁决路径（发退款指令事件）禁 claim——费由退款腿分账（pad→feeRecipient、reward→payer）。
        if (await isAdjudicatedSettled(cfg, dir, ch, seq, txHash)) {
            console.log(`[bridge] dir=${dir} seq=${seq} 属过期裁决路径（指令事件命中），跳过领奖腿（退款腿接力）`);
            return;
        }
        const spec = claimSpec(cfg, dir, ch, erc20, seq);
        if (spec.rpcUrl == null || spec.to == null) return;
        if (!(await claimOp(db, spec.direction, spec.key))) return; // 已处理/他实例抢占
        await db.prepare('update ops set payload=? where direction=? and op_key=?')
            .bind(JSON.stringify(spec.payload), spec.direction, spec.key).run();
        const st = await readFees(callRaw, spec.rpcUrl, spec.to, spec.abi, spec.viewFn, spec.viewArgs);
        if (st.state === 2) {
            await finishOp(db, spec.direction, spec.key, 'already-claimed');
            return;
        }
        await attemptClaim(env, cfg, wallet, db, spec);
    } catch (e) {
        console.log(`[bridge] ensureClaim dir=${dir} seq=${seq} 异常（忽略）：${String(e.message).slice(0, 160)}`);
    }
}

// 领奖腿 pending 重试（payload 存档回放；每 tick 一次，relayForward 入口调用）。
async function retryPendingClaims(env, cfg, wallet, db) {
    let rows;
    try {
        rows = await db.prepare(
            `select direction, op_key, payload, attempts from ops where status='pending' and direction like 'fee_claim%' and (fee_state is null or fee_state not in ('refund_stuck','claim_stuck'))`
        ).all();
    } catch (e) {
        console.log(`[bridge] claim 重试读表异常：${String(e.message).slice(0, 120)}`);
        return;
    }
    for (const row of rows.results ?? []) {
        try {
            const p = JSON.parse(row.payload || '{}');
            const dir = p.dir;
            if (!dir || p.seq == null) continue;
            let ch = null;
            if (dir === 1) ch = cfg.channels.find((c) => String(c.chainIndex) === String(p.chainIndex));
            else if (dir === 3) ch = cfg.outChannels.find((c) => String(c.chainIndex) === String(p.chainIndex) && Boolean(c.srcToken) === Boolean(p.erc20));
            else if (dir === 4) ch = cfg.outChannels.find((c) => String(c.chainIndex) === String(p.chainIndex));
            if ((dir === 1 || dir === 3 || dir === 4) && !ch?.vault) continue; // 配置缺失，等下一轮
            const spec = claimSpec(cfg, dir, ch, p.erc20, BigInt(p.seq));
            if (spec.rpcUrl == null || spec.to == null) continue;
            const st = await readFees(callRaw, spec.rpcUrl, spec.to, spec.abi, spec.viewFn, spec.viewArgs);
            if (st.state === 2) {
                await finishOp(db, row.direction, row.op_key, 'confirmed-on-retry');
                continue;
            }
            if (row.attempts >= cfg.maxAttempts) continue; // 领奖腿无二级 deadline，超限挂人工（现役退款腿同款）
            await attemptClaim(env, cfg, wallet, db, spec);
        } catch (e) {
            console.log(`[bridge] claim 重试异常 key=${row.op_key}: ${String(e.message).slice(0, 160)}`);
        }
    }
}

// ---------------- 正向 ----------------

export async function relayForward(env, cfg, wallet, db) {
    // 领奖腿 pending 重试（每 tick 一次；独立于四向中继，失败不阻塞）
    try { await retryPendingClaims(env, cfg, wallet, db); } catch (e) { console.log(`[bridge] claim 重试总异常：${String(e.message).slice(0, 120)}`); }
    for (const ch of cfg.channels) {
        const src = cfg.srcChains[String(ch.chainIndex)];
        if (!src?.rpcUrl || !ch.vault) {
            console.log(`[bridge] 通道 ${ch.chainIndex}/${ch.srcToken} 缺 rpc/vault 配置，跳过`);
            continue;
        }
        try {
            await retryPendingMints(env, cfg, wallet, db, ch);
            await forwardChannel(env, cfg, wallet, db, ch, src);
        } catch (e) {
            console.log(`[bridge] 正向 chainIndex=${ch.chainIndex} tick 异常：${String(e.message).slice(0, 120)}`);
        }
    }
}

async function forwardChannel(env, cfg, wallet, db, ch, src) {
    const curKey = `src:${ch.chainIndex}`;
    const curName = `deposit:${String(ch.srcToken).toLowerCase()}`;
    const head = await latestBlock(src.rpcUrl);
    const safeTo = head - src.confirmations;
    let cursor = await getCursor(db, curKey, curName);
    if (cursor === null) {
        await setCursor(db, curKey, curName, safeTo); // 首轮落基线
        console.log(`[bridge] 通道 ${ch.chainIndex} 游标基线 → ${safeTo}`);
        return;
    }
    if (safeTo <= cursor) return;

    const logs = await rpc(src.rpcUrl, 'eth_getLogs', [{
        address: ch.vault,
        topics: [DEPOSIT_TOPIC],
        fromBlock: toHex(cursor + 1n),
        toBlock: toHex(safeTo),
    }]);
    for (const log of logs) {
        let ev;
        try {
            ev = decodeEventLog({ abi: vaultAbi, data: log.data, topics: log.topics });
        } catch {
            continue; // 非 Deposit 形状（理论上 topic0 已滤）
        }
        if (ev.eventName !== 'Deposit') continue;
        // 通道-资产对齐（2026-09-18 07 联调修复）：一链多通道共用同一 BridgeVault 地址时，
        // getLogs 按 vault 地址扫出的是**全部资产**的 Deposit——必须按本通道 srcToken 过滤，
        // 否则先抢到 op 的通道会把别的资产存款铸成自己的 spToken（op_key=chainIndex:seq
        // 跨通道撞号，先到先得）。BSC 双通道（USDT+wnative）正是该拓扑。
        if (String(ev.args.token).toLowerCase() !== String(ch.srcToken).toLowerCase()) continue;
        const seq = ev.args.seq;
        const key = `${ch.chainIndex}:${seq}`;
        if (!(await claimOp(db, 'mint', key))) continue; // 他实例/前轮已抢占
        if (await isMinted(cfg, ch, seq)) {
            await finishOp(db, 'mint', key, 'already-minted');
            await ensureClaim(env, cfg, wallet, db, { dir: 1, ch, seq }); // 已落地 → 补领奖腿
            continue;
        }
        const spAmount = to18(ev.args.amount, ch.srcDecimals);
        const buyDeadline = ev.args.buyDeadline ?? 0n; // 0 = 永不过期（尾参，随签名/topic0 更替）
        console.log(`[bridge] Deposit seq=${seq} amount=${ev.args.amount} → mint ${spAmount} → ${ev.args.recipient}${buyDeadline !== 0n ? ` deadline ${buyDeadline}` : ''}`);
        if (cfg.dryRun) {
            await finishOp(db, 'mint', key, 'dry-run');
            continue;
        }
        // 费率准入闸门（§3.2）：达标 → 广播；不足 → insufficient 跳过；过期 → 裁决腿/垃圾终态。
        const act = await feeAction(env, cfg, db, { dir: 1, ch, erc20: false, seq, buyDeadlineSecs: buyDeadline, direction: 'mint', key });
        if (act.action === 'insufficient') { console.log(`[bridge] Deposit seq=${seq} 准入不足（fee_state=insufficient），本轮不广播`); continue; }
        if (act.action === 'never_sweep') { await finishOp(db, 'mint', key, 'never_sweep'); continue; }
        if (act.action === 'terminal') { await finishOp(db, 'mint', key, 'fee-terminal'); continue; }
        const data = encodeFunctionData({
            abi: spBridgeAbi, functionName: 'executeMint',
            args: [BigInt(ch.chainIndex), seq, ch.spToken, ev.args.recipient, spAmount, buyDeadline],
        });
        let txHash = null;
        try {
            txHash = await sendTx(cfg.hub.rpcUrl, wallet, { to: cfg.hub.spBridge, data }, cfg);
            console.log(`[bridge] executeMint 广播: ${txHash ?? '(dry)'}`);
            await ctxWait(env, mintedSettle(env, cfg, wallet, db, ch, key, seq, txHash));
        } catch (e) {
            console.log(`[bridge] executeMint 异常 seq=${seq}: ${String(e.message).slice(0, 200)}\n${String(e.stack).split("\n").slice(1, 4).join("\n")}`);
            const exhausted = await failOp(db, 'mint', key, e, cfg.maxAttempts);
            if (exhausted) {
                await notify(env, { event: 'mint_stuck', channel: ch.chainIndex, seq, error: String(e.message).slice(0, 200) });
            }
        }
    }
    await setCursor(db, curKey, curName, safeTo);
}

// 广播后短暂等链上幂等位翻转（拿不到就留给下一轮重试通道对账）
function mintedSettle(env, cfg, wallet, db, ch, key, seq, txHash) {
    return (async () => {
        if (txHash == null) return; // 估算跳过/dryRun：未广播，不发假通知、不轮询幂等位
        for (let i = 0; i < 3; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            if (await isMinted(cfg, ch, seq)) {
                await finishOp(db, 'mint', key, txHash ?? 'confirmed');
                await notify(env, { event: 'mint_sent', channel: ch.chainIndex, seq, tx: txHash });
                await ensureClaim(env, cfg, wallet, db, { dir: 1, ch, seq, txHash }); // B 链成功 → 领奖腿（过期裁决门内判）
                return;
            }
        }
        await notify(env, { event: 'mint_broadcast', channel: ch.chainIndex, seq, tx: txHash, note: '回执未确认，下轮对账' });
    })();
}

async function isMinted(cfg, ch, seq) {
    const key = channelKeyOf(ch.chainIndex, ch.srcToken);
    const raw = await callRaw(cfg.hub.rpcUrl, cfg.hub.spBridge,
        encodeFunctionData({ abi: spBridgeAbi, functionName: 'minted', args: [key, seq] }));
    return decodeFunctionResult({ abi: spBridgeAbi, functionName: 'minted', data: raw });
}

// pending 重试：链上幂等位命中 → done；未命中且未超限 → 重发（参数从 Vault.deposits(seq) 现读，
// 不依赖本地留存——isolate 重启/D1 丢 payload 都能恢复）
async function retryPendingMints(env, cfg, wallet, db, ch) {
    const rows = await db.prepare(
        `select op_key, attempts from ops where direction='mint' and status='pending' and op_key like ? and (fee_state is null or fee_state not in ('mint_stuck'))`
    ).bind(`${ch.chainIndex}:%`).all();
    for (const row of rows.results ?? []) {
        const seq = BigInt(row.op_key.split(':')[1]);
        try {
            if (await isMinted(cfg, ch, seq)) {
                await finishOp(db, 'mint', row.op_key, 'confirmed-on-retry');
                await ensureClaim(env, cfg, wallet, db, { dir: 1, ch, seq }); // 已落地 → 补领奖腿
                continue;
            }
            const depRaw = await callRaw(ch.rpcUrl ?? cfg.srcChains[String(ch.chainIndex)].rpcUrl, ch.vault,
                encodeFunctionData({ abi: vaultAbi, functionName: 'deposits', args: [seq] }));
            const dep = decodeFunctionResult({
                abi: vaultAbi, functionName: 'deposits', data: depRaw,
            });
            const [token, , recipient, amount] = Array.isArray(dep) ? dep : [dep.token, dep.depositor, dep.recipient, dep.amount];
            const buyDeadline = (Array.isArray(dep) ? dep[4] : dep.buyDeadline) ?? 0n; // 尾参（§3.4 元组收缩）
            if (token.toLowerCase() !== String(ch.srcToken).toLowerCase()) continue;
            if (row.attempts >= cfg.maxAttempts) continue; // F-018a 达上限不再重发（口径同 refund.js:183；既有失败路径已告警，不新增终态）
            // 费率闸门：达标/过期裁决 → 广播；不足 → 跳过；垃圾 → never_sweep 终态（超限不再挂人工，§3.1）
            const act = await feeAction(env, cfg, db, { dir: 1, ch, erc20: false, seq, buyDeadlineSecs: buyDeadline, direction: 'mint', key: row.op_key });
            if (act.action === 'insufficient') continue;
            if (act.action === 'never_sweep') { await finishOp(db, 'mint', row.op_key, 'never_sweep'); continue; }
            if (act.action === 'terminal') { await finishOp(db, 'mint', row.op_key, 'fee-terminal'); continue; }
            const data = encodeFunctionData({
                abi: spBridgeAbi, functionName: 'executeMint',
                args: [BigInt(ch.chainIndex), seq, ch.spToken, recipient, to18(amount, ch.srcDecimals), buyDeadline],
            });
            const txHash = await sendTx(cfg.hub.rpcUrl, wallet, { to: cfg.hub.spBridge, data }, cfg);
            if (txHash == null) { await noteEstimateFail(env, cfg, db, { direction: 'mint', key: row.op_key, chainIndex: ch.chainIndex, seq }); continue; } // F-018b 估 gas 连败计次
            await ctxWait(env, mintedSettle(env, cfg, wallet, db, ch, row.op_key, seq, txHash));
        } catch (e) {
            const exhausted = await failOp(db, 'mint', row.op_key, e, cfg.maxAttempts);
            if (exhausted) {
                await notify(env, { event: 'mint_stuck', channel: ch.chainIndex, seq: String(seq), error: String(e.message).slice(0, 200) });
            }
        }
    }
}

// ---------------- 反向 ----------------

export async function relayReverse(env, cfg, wallet, db) {
    const hub = cfg.hub;
    if (!hub.rpcUrl || !hub.spBridge) return;
    try {
        await retryPendingReleases(env, cfg, wallet, db);
        const head = await latestBlock(hub.rpcUrl);
        const conf = BigInt(JSON.parse(env.SRC_CHAINS || '{}')?.hub?.confirmations ?? 2);
        const safeTo = head - conf;
        let cursor = await getCursor(db, 'hub', 'burn');
        if (cursor === null) {
            await setCursor(db, 'hub', 'burn', safeTo);
            console.log(`[bridge] hub 游标基线 → ${safeTo}`);
            return;
        }
        if (safeTo <= cursor) return;

        const logs = await rpc(hub.rpcUrl, 'eth_getLogs', [{
            address: hub.spBridge,
            topics: [BURN_TOPIC],
            fromBlock: toHex(cursor + 1n),
            toBlock: toHex(safeTo),
        }]);
        for (const log of logs) {
            let ev;
            try {
                ev = decodeEventLog({ abi: spBridgeAbi, data: log.data, topics: log.topics });
            } catch {
                continue;
            }
            if (ev.eventName !== 'BurnRequest') continue;
            const { seq, spToken, chainIndex, recipient, amount, buyDeadline } = ev.args;
            const ch = cfg.channels.find((c) =>
                BigInt(c.chainIndex) === chainIndex && String(c.spToken).toLowerCase() === String(spToken).toLowerCase());
            if (!ch) continue; // 非本 relayer 的通道
            const key = String(seq);
            if (!(await claimOp(db, 'release', key))) continue;
            if (await isReleased(cfg, ch, seq)) {
                await finishOp(db, 'release', key, 'already-released');
                await ensureClaim(env, cfg, wallet, db, { dir: 2, ch, seq }); // 已落地 → 补领奖腿
                continue;
            }
            const payload = JSON.stringify({
                seq: String(seq), srcToken: ch.srcToken, recipient, amount: String(amount),
                srcDecimals: ch.srcDecimals, chainIndex: String(ch.chainIndex),
                buyDeadline: String(buyDeadline ?? 0n), // 扩存：尾参随消息携带，重试路径 payload 取
            });
            await db.prepare('update ops set payload=? where direction=? and op_key=?')
                .bind(payload, 'release', key).run();
            await attemptRelease(env, cfg, wallet, db, ch, {
                seq, recipient, amount, srcToken: ch.srcToken, srcDecimals: ch.srcDecimals,
                buyDeadline: buyDeadline ?? 0n,
            }, key);
        }
        await setCursor(db, 'hub', 'burn', safeTo);
    } catch (e) {
        console.log(`[bridge] 反向 tick 异常：${String(e.message).slice(0, 120)}`);
    }
}

// 单次释放尝试：池余额预检（挂起告警，不打必败交易）
async function attemptRelease(env, cfg, wallet, db, ch, p, key) {
    const srcRpc = cfg.srcChains[String(ch.chainIndex)]?.rpcUrl;
    if (!srcRpc) {
        await failOp(db, 'release', key, 'no src rpc', cfg.maxAttempts);
        return;
    }
    const amountSrc = from18(BigInt(p.amount), p.srcDecimals);
    if (amountSrc === 0n) {
        await finishOp(db, 'release', key, 'dust-after-floor'); // 尾差留池
        return;
    }
    // 预检 1：池余额 ≥ 释放额
    const poolRaw = await callRaw(srcRpc, ch.vault,
        encodeFunctionData({ abi: vaultAbi, functionName: 'poolBalance', args: [p.srcToken] }));
    const pool = decodeFunctionResult({ abi: vaultAbi, functionName: 'poolBalance', data: poolRaw });
    if (pool < amountSrc) {
        const exhausted = await failOp(db, 'release', key, 'pool insufficient', cfg.maxAttempts);
        if (exhausted) {
            await notify(env, { event: 'pool_insufficient', channel: ch.chainIndex, seq: p.seq, pool: String(pool), need: String(amountSrc) });
        }
        return;
    }
    if (cfg.dryRun) {
        await finishOp(db, 'release', key, 'dry-run');
        return;
    }
    // 费率闸门（§3.2）：dir2 费 escrow 在 hub（burnFees）。
    const act = await feeAction(env, cfg, db, { dir: 2, ch, erc20: false, seq: BigInt(p.seq), buyDeadlineSecs: p.buyDeadline, direction: 'release', key });
    if (act.action === 'insufficient') return;
    if (act.action === 'never_sweep') { await finishOp(db, 'release', key, 'never_sweep'); return; }
    if (act.action === 'terminal') { await finishOp(db, 'release', key, 'fee-terminal'); return; }
    const data = encodeFunctionData({
        abi: vaultAbi, functionName: 'executeRelease',
        args: [BigInt(p.seq), p.srcToken, p.recipient, amountSrc, BigInt(p.buyDeadline ?? 0n)],
    });
    try {
        const txHash = await sendTx(srcRpc, wallet, { to: ch.vault, data }, cfg);
        if (txHash == null) { await noteEstimateFail(env, cfg, db, { direction: 'release', key, chainIndex: ch.chainIndex, seq: p.seq }); return; } // F-018b 估 gas 连败计次
        console.log(`[bridge] executeRelease 广播: ${txHash ?? '(dry)'}`);
        await ctxWait(env, releasedSettle(env, cfg, wallet, db, ch, key, p.seq, txHash));
    } catch (e) {
        console.log(`[bridge] executeRelease 异常 seq=${p.seq}: ${String(e.message).slice(0, 200)}`);
        const exhausted = await failOp(db, 'release', key, e, cfg.maxAttempts);
        if (exhausted) {
            await notify(env, { event: 'release_stuck', channel: ch.chainIndex, seq: p.seq, error: String(e.message).slice(0, 200) });
        }
    }
}

function releasedSettle(env, cfg, wallet, db, ch, key, seq, txHash) {
    return (async () => {
        if (txHash == null) return; // 估算跳过/dryRun：未广播，不发假通知、不轮询幂等位
        for (let i = 0; i < 3; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            if (await isReleased(cfg, ch, seq)) {
                await finishOp(db, 'release', key, txHash ?? 'confirmed');
                await notify(env, { event: 'release_sent', channel: ch.chainIndex, seq, tx: txHash });
                await ensureClaim(env, cfg, wallet, db, { dir: 2, ch, seq, txHash }); // B 链成功 → 领奖腿（过期裁决门内判）
                return;
            }
        }
        await notify(env, { event: 'release_broadcast', channel: ch.chainIndex, seq, tx: txHash, note: '回执未确认，下轮对账' });
    })();
}

async function isReleased(cfg, ch, seq) {
    const srcRpc = cfg.srcChains[String(ch.chainIndex)]?.rpcUrl;
    const raw = await callRaw(srcRpc, ch.vault,
        encodeFunctionData({ abi: vaultAbi, functionName: 'released', args: [seq] }));
    return decodeFunctionResult({ abi: vaultAbi, functionName: 'released', data: raw });
}

// pending 释放重试：released 命中 → done；否则用 ops.payload 里的参数重发
async function retryPendingReleases(env, cfg, wallet, db) {
    const rows = await db.prepare(
        `select op_key, payload, attempts from ops where direction='release' and status='pending' and (fee_state is null or fee_state not in ('release_stuck'))`
    ).all();
    for (const row of rows.results ?? []) {
        try {
            const p = JSON.parse(row.payload || '{}');
            if (!p.seq) continue;
            const ch = cfg.channels.find((c) =>
                String(c.chainIndex) === String(p.chainIndex)
                && String(c.srcToken).toLowerCase() === String(p.srcToken).toLowerCase());
            if (!ch) continue;
            if (await isReleased(cfg, ch, BigInt(p.seq))) {
                await finishOp(db, 'release', row.op_key, 'confirmed-on-retry');
                await ensureClaim(env, cfg, wallet, db, { dir: 2, ch, seq: BigInt(p.seq) }); // 已落地 → 补领奖腿
                continue;
            }
            if (row.attempts >= cfg.maxAttempts) continue; // F-018a 达上限不再重发（口径同 refund.js:183）
            await attemptRelease(env, cfg, wallet, db, ch, p, row.op_key);
        } catch (e) {
            await failOp(db, 'release', row.op_key, e, cfg.maxAttempts);
        }
    }
}

// ctx.waitUntil 的可选拆包（单测里没有 ctx）
function ctxWait(env, promise) {
    return promise;
}

// ---------------- 出向：hub LockOut → 外链铸 spN ----------------
// 镜像 mint 方向：hub 侧事件驱动，参数可从 outLocks/outLocksErc20(seq) 链上现读；spoke 侧
// outMinted/outMintedErc20 幂等位对账。native(hub outSeq) 与 erc20(hub outSeqErc20) 双计数器
// 各自从 1 起、数值可重叠，且两族落同一出向金库实例（web 出向共用单一 out.vault/spN）⇒ 必须
// 分族幂等键：尾传 bool erc20（native=false 走 outMinted，erc20=true 走 outMintedErc20）；
// op direction 亦分族（out_mint / out_mint_erc20）。族判定=事件 outKey（native=_key(chainIndex,0)，
// erc20=_key(chainIndex,srcToken)，与合约 _key 同构）。

const OUT_MINT_DIR = { native: 'out_mint', erc20: 'out_mint_erc20' };

// 按事件 outKey 定位出向通道并判族（同一 chainIndex 可并存 native+erc20 两通道，不可按 chainIndex 单选）
function matchOutChannel(cfg, chainIndex, outKey) {
    if (!outKey) return null;
    const key = String(outKey).toLowerCase();
    for (const c of cfg.outChannels) {
        if (BigInt(c.chainIndex) !== chainIndex) continue;
        const erc20 = !!c.srcToken;
        const expect = erc20 ? channelKeyOf(c.chainIndex, c.srcToken) : outKeyOf(c.chainIndex);
        if (String(expect).toLowerCase() === key) return { ch: c, erc20 };
    }
    return null;
}

export async function relayOutForward(env, cfg, wallet, db) {
    const hub = cfg.hub;
    if (!hub.rpcUrl || !hub.spBridge || cfg.outChannels.length === 0) return;
    try {
        await retryPendingOutMints(env, cfg, wallet, db);
        const head = await latestBlock(hub.rpcUrl);
        const conf = BigInt(JSON.parse(env.SRC_CHAINS || '{}')?.hub?.confirmations ?? 2);
        const safeTo = head - conf;
        let cursor = await getCursor(db, 'hub', 'outlock');
        if (cursor === null) {
            await setCursor(db, 'hub', 'outlock', safeTo);
            console.log(`[bridge] hub 出向游标基线 → ${safeTo}`);
            return;
        }
        if (safeTo <= cursor) return;

        const logs = await rpc(hub.rpcUrl, 'eth_getLogs', [{
            address: hub.spBridge,
            topics: [LOCKOUT_TOPIC],
            fromBlock: toHex(cursor + 1n),
            toBlock: toHex(safeTo),
        }]);
        for (const log of logs) {
            let ev;
            try {
                ev = decodeEventLog({ abi: spBridgeAbi, data: log.data, topics: log.topics });
            } catch {
                continue;
            }
            if (ev.eventName !== 'LockOut') continue;
            const { seq, outKey, chainIndex, recipient, amount, buyDeadline } = ev.args;
            const hit = matchOutChannel(cfg, chainIndex, outKey);
            if (!hit) continue; // 非本 relayer 的出向通道
            const { ch, erc20 } = hit;
            const direction = erc20 ? OUT_MINT_DIR.erc20 : OUT_MINT_DIR.native;
            const key = `${chainIndex}:${seq}`;
            if (!(await claimOp(db, direction, key))) continue;
            if (await isOutMinted(cfg, ch, seq, erc20)) {
                await finishOp(db, direction, key, 'already-minted');
                await ensureClaim(env, cfg, wallet, db, { dir: 3, ch, erc20, seq }); // 已落地 → 补领奖腿
                continue;
            }
            await db.prepare('update ops set payload=? where direction=? and op_key=?')
                .bind(JSON.stringify({
                    seq: String(seq), chainIndex: String(chainIndex), recipient,
                    amount: String(amount),
                    buyDeadline: String(buyDeadline ?? 0n), // 尾参随消息携带，重试路径 payload 取
                }), direction, key).run();
            await attemptOutMint(env, cfg, wallet, db, ch, { seq, recipient, amount, buyDeadline: buyDeadline ?? 0n }, key, erc20, direction);
        }
        await setCursor(db, 'hub', 'outlock', safeTo);
    } catch (e) {
        console.log(`[bridge] 出向正向 tick 异常：${String(e.message).slice(0, 120)}`);
    }
}

async function attemptOutMint(env, cfg, wallet, db, ch, p, key, erc20, direction) {
    const srcRpc = cfg.srcChains[String(ch.chainIndex)]?.rpcUrl;
    if (!srcRpc) {
        await failOp(db, direction, key, 'no spoke rpc', cfg.maxAttempts);
        return;
    }
    if (cfg.dryRun) {
        await finishOp(db, direction, key, 'dry-run');
        return;
    }
    // 费率闸门（§3.2）：dir3 费 escrow 在 hub（outLockFees / outLockFeesErc20）。
    const act = await feeAction(env, cfg, db, { dir: 3, ch, erc20, seq: BigInt(p.seq), buyDeadlineSecs: p.buyDeadline, direction, key });
    if (act.action === 'insufficient') return;
    if (act.action === 'never_sweep') { await finishOp(db, direction, key, 'never_sweep'); return; }
    if (act.action === 'terminal') { await finishOp(db, direction, key, 'fee-terminal'); return; }
    // 分族：尾参 bool erc20 决定合约侧幂等键空间（native=outMinted、erc20=outMintedErc20）
    const data = encodeFunctionData({
        abi: outVaultAbi, functionName: 'executeOutMint',
        args: [p.seq, p.recipient, p.amount, BigInt(p.buyDeadline ?? 0n), erc20],
    });
    try {
        const txHash = await sendTx(srcRpc, wallet, { to: ch.vault, data }, cfg);
        if (txHash == null) { await noteEstimateFail(env, cfg, db, { direction, key, chainIndex: ch.chainIndex, seq: p.seq }); return; } // F-018b 估 gas 连败计次
        console.log(`[bridge] executeOutMint 广播: ${txHash ?? '(dry)'}`);
        await ctxWait(env, outMintedSettle(env, cfg, wallet, db, ch, key, p.seq, txHash, erc20, direction));
    } catch (e) {
        console.log(`[bridge] executeOutMint 异常 seq=${p.seq}: ${String(e.message).slice(0, 200)}`);
        const exhausted = await failOp(db, direction, key, e, cfg.maxAttempts);
        if (exhausted) {
            await notify(env, { event: 'out_mint_stuck', channel: ch.chainIndex, seq: String(p.seq), error: String(e.message).slice(0, 200) });
        }
    }
}

function outMintedSettle(env, cfg, wallet, db, ch, key, seq, txHash, erc20, direction) {
    return (async () => {
        if (txHash == null) return; // 估算跳过/dryRun：未广播，不发假通知、不轮询幂等位
        for (let i = 0; i < 3; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            if (await isOutMinted(cfg, ch, seq, erc20)) {
                await finishOp(db, direction, key, txHash ?? 'confirmed');
                await notify(env, { event: 'out_mint_sent', channel: ch.chainIndex, seq, tx: txHash });
                await ensureClaim(env, cfg, wallet, db, { dir: 3, ch, erc20, seq, txHash }); // B 链成功 → 领奖腿（过期裁决门内判）
                return;
            }
        }
        await notify(env, { event: 'out_mint_broadcast', channel: ch.chainIndex, seq, tx: txHash, note: '回执未确认，下轮对账' });
    })();
}

// 分族幂等位对账：erc20 → outMintedErc20；native → outMinted
async function isOutMinted(cfg, ch, seq, erc20) {
    const srcRpc = cfg.srcChains[String(ch.chainIndex)]?.rpcUrl;
    const fn = erc20 ? 'outMintedErc20' : 'outMinted';
    const raw = await callRaw(srcRpc, ch.vault,
        encodeFunctionData({ abi: outVaultAbi, functionName: fn, args: [seq] }));
    return decodeFunctionResult({ abi: outVaultAbi, functionName: fn, data: raw });
}

// pending 出向铸造重试（分族两向）：幂等位命中 → done；否则参数从 hub outLocks/outLocksErc20(seq) 现读后重发
async function retryPendingOutMints(env, cfg, wallet, db) {
    for (const direction of [OUT_MINT_DIR.native, OUT_MINT_DIR.erc20]) {
        const erc20 = direction === OUT_MINT_DIR.erc20;
        const rows = await db.prepare(
            `select op_key, attempts from ops where direction=? and status='pending' and (fee_state is null or fee_state not in ('out_mint_stuck','out_mint_erc20_stuck'))`
        ).bind(direction).all();
        for (const row of rows.results ?? []) {
            const [chainIndexStr, seqStr] = row.op_key.split(':');
            const seq = BigInt(seqStr);
            const ch = cfg.outChannels.find((c) => String(c.chainIndex) === chainIndexStr && (erc20 ? !!c.srcToken : !c.srcToken));
            if (!ch) continue;
            try {
                if (await isOutMinted(cfg, ch, seq, erc20)) {
                    await finishOp(db, direction, row.op_key, 'confirmed-on-retry');
                    await ensureClaim(env, cfg, wallet, db, { dir: 3, ch, erc20, seq }); // 已落地 → 补领奖腿
                    continue;
                }
                if (row.attempts >= cfg.maxAttempts) continue; // F-018a 达上限不再重发（口径同 refund.js:183）
                const lockFn = erc20 ? 'outLocksErc20' : 'outLocks';
                const lockRaw = await callRaw(cfg.hub.rpcUrl, cfg.hub.spBridge,
                    encodeFunctionData({ abi: spBridgeAbi, functionName: lockFn, args: [seq] }));
                const lock = decodeFunctionResult({ abi: spBridgeAbi, functionName: lockFn, data: lockRaw });
                const recipient = Array.isArray(lock) ? lock[erc20 ? 2 : 1] : lock.recipient;
                const amount = Array.isArray(lock) ? lock[erc20 ? 3 : 2] : lock.amount;
                const buyDeadline = (Array.isArray(lock) ? lock[erc20 ? 5 : 4] : lock.buyDeadline) ?? 0n; // 元组收缩尾参
                await attemptOutMint(env, cfg, wallet, db, ch, { seq, recipient, amount, buyDeadline }, row.op_key, erc20, direction);
            } catch (e) {
                const exhausted = await failOp(db, direction, row.op_key, e, cfg.maxAttempts);
                if (exhausted) {
                    await notify(env, { event: 'out_mint_stuck', channel: chainIndexStr, seq: String(seq), error: String(e.message).slice(0, 200) });
                }
            }
        }
    }
}

// ---------------- 出向反向：外链 BurnOut → hub 解锁 wnative ----------------
// 镜像 release 方向：spoke 侧事件驱动；hub 侧 outReleased(chainIndex, outBurnId) 幂等位
// 对账 + outStanding 在库预检。outBurnId 是 OutVault 本链自增（非全局），op_key 必须带链维度。

export async function relayOutReverse(env, cfg, wallet, db) {
    const hub = cfg.hub;
    if (!hub.rpcUrl || !hub.spBridge) return;
    for (const ch of cfg.outChannels) {
        const src = cfg.srcChains[String(ch.chainIndex)];
        if (!src?.rpcUrl || !ch.vault) {
            console.log(`[bridge] 出向通道 ${ch.chainIndex} 缺 rpc/vault 配置，跳过`);
            continue;
        }
        try {
            await retryPendingOutReleases(env, cfg, wallet, db, ch);
            const head = await latestBlock(src.rpcUrl);
            const safeTo = head - src.confirmations;
            const curKey = `src:${ch.chainIndex}`;
            let cursor = await getCursor(db, curKey, 'outburn');
            if (cursor === null) {
                await setCursor(db, curKey, 'outburn', safeTo);
                console.log(`[bridge] 出向通道 ${ch.chainIndex} 反向游标基线 → ${safeTo}`);
                continue;
            }
            if (safeTo <= cursor) continue;

            const logs = await rpc(src.rpcUrl, 'eth_getLogs', [{
                address: ch.vault,
                topics: [BURNOUT_TOPIC],
                fromBlock: toHex(cursor + 1n),
                toBlock: toHex(safeTo),
            }]);
            for (const log of logs) {
                let ev;
                try {
                    ev = decodeEventLog({ abi: outVaultAbi, data: log.data, topics: log.topics });
                } catch {
                    continue;
                }
                if (ev.eventName !== 'BurnOut') continue;
                const { outBurnId, recipient, amount, buyDeadline } = ev.args;
                const key = `${ch.chainIndex}:${outBurnId}`; // outBurnId 非全局，必须带链维度防撞
                if (!(await claimOp(db, 'out_release', key))) continue;
                if (await isOutReleased(cfg, ch, outBurnId)) {
                    await finishOp(db, 'out_release', key, 'already-released');
                    await ensureClaim(env, cfg, wallet, db, { dir: 4, ch, seq: outBurnId }); // 已落地 → 补领奖腿
                    continue;
                }
                await db.prepare('update ops set payload=? where direction=? and op_key=?')
                    .bind(JSON.stringify({
                        outBurnId: String(outBurnId), chainIndex: String(ch.chainIndex),
                        recipient, amount: String(amount),
                        buyDeadline: String(buyDeadline ?? 0n), // 扩存：尾参随消息携带，重试路径 payload 取
                    }), 'out_release', key).run();
                await attemptOutRelease(env, cfg, wallet, db, ch, { outBurnId, recipient, amount, buyDeadline: buyDeadline ?? 0n }, key);
            }
            await setCursor(db, curKey, 'outburn', safeTo);
        } catch (e) {
            console.log(`[bridge] 出向反向 chainIndex=${ch.chainIndex} tick 异常：${String(e.message).slice(0, 120)}`);
        }
    }
}

async function attemptOutRelease(env, cfg, wallet, db, ch, p, key) {
    const hubRpc = cfg.hub.rpcUrl;
    // 预检 1：hub 在库净锁定 ≥ 烧毁毛额（spN 全额背书校验）
    // ERC20 通道在库量在 outStandingErc20(outKeyE20)；native 在 outStanding(outKeyOf(chainIndex))
    const standingFn = ch.srcToken ? 'outStandingErc20' : 'outStanding';
    const standingArgs = ch.srcToken ? [channelKeyOf(ch.chainIndex, ch.srcToken)] : [outKeyOf(ch.chainIndex)];
    const outStandingRaw = await callRaw(hubRpc, cfg.hub.spBridge,
        encodeFunctionData({ abi: spBridgeAbi, functionName: standingFn, args: standingArgs }));
    const standing = decodeFunctionResult({ abi: spBridgeAbi, functionName: standingFn, data: outStandingRaw });
    if (standing < p.amount) {
        const exhausted = await failOp(db, 'out_release', key, 'insufficient locked', cfg.maxAttempts);
        if (exhausted) {
            await notify(env, { event: 'out_locked_insufficient', channel: ch.chainIndex, outBurnId: p.outBurnId, standing: String(standing), need: String(p.amount) });
        }
        return;
    }
    if (cfg.dryRun) {
        await finishOp(db, 'out_release', key, 'dry-run');
        return;
    }
    // 费率闸门（§3.2）：dir4 费 escrow 在源链 vault-out（outBurnFees）。
    const act = await feeAction(env, cfg, db, { dir: 4, ch, erc20: false, seq: BigInt(p.outBurnId), buyDeadlineSecs: p.buyDeadline, direction: 'out_release', key });
    if (act.action === 'insufficient') return;
    if (act.action === 'never_sweep') { await finishOp(db, 'out_release', key, 'never_sweep'); return; }
    if (act.action === 'terminal') { await finishOp(db, 'out_release', key, 'fee-terminal'); return; }
    const data = ch.srcToken
        ? encodeFunctionData({
            abi: spBridgeAbi, functionName: 'executeOutReleaseERC20',
            args: [BigInt(ch.chainIndex), ch.srcToken, p.outBurnId, p.recipient, p.amount, BigInt(p.buyDeadline ?? 0n)],
        })
        : encodeFunctionData({
            abi: spBridgeAbi, functionName: 'executeOutRelease',
            args: [BigInt(ch.chainIndex), p.outBurnId, p.recipient, p.amount, BigInt(p.buyDeadline ?? 0n)],
        });
    try {
        const txHash = await sendTx(hubRpc, wallet, { to: cfg.hub.spBridge, data }, cfg);
        if (txHash == null) { await noteEstimateFail(env, cfg, db, { direction: 'out_release', key, chainIndex: ch.chainIndex, seq: p.outBurnId }); return; } // F-018b 估 gas 连败计次
        console.log(`[bridge] executeOutRelease 广播: ${txHash ?? '(dry)'}`);
        await ctxWait(env, outReleasedSettle(env, cfg, wallet, db, ch, key, p.outBurnId, txHash));
    } catch (e) {
        console.log(`[bridge] executeOutRelease 异常 outBurnId=${p.outBurnId}: ${String(e.message).slice(0, 200)}`);
        const exhausted = await failOp(db, 'out_release', key, e, cfg.maxAttempts);
        if (exhausted) {
            await notify(env, { event: 'out_release_stuck', channel: ch.chainIndex, outBurnId: p.outBurnId, error: String(e.message).slice(0, 200) });
        }
    }
}

function outReleasedSettle(env, cfg, wallet, db, ch, key, outBurnId, txHash) {
    return (async () => {
        if (txHash == null) return; // 估算跳过/dryRun：未广播，不发假通知、不轮询幂等位
        for (let i = 0; i < 3; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            if (await isOutReleased(cfg, ch, outBurnId)) {
                await finishOp(db, 'out_release', key, txHash ?? 'confirmed');
                await notify(env, { event: 'out_release_sent', channel: ch.chainIndex, outBurnId, tx: txHash });
                await ensureClaim(env, cfg, wallet, db, { dir: 4, ch, seq: outBurnId, txHash }); // B 链成功 → 领奖腿（过期裁决门内判）
                return;
            }
        }
        await notify(env, { event: 'out_release_broadcast', channel: ch.chainIndex, outBurnId, tx: txHash, note: '回执未确认，下轮对账' });
    })();
}

async function isOutReleased(cfg, ch, outBurnId) {
    // ERC20 出向通道（ch.srcToken 存在）幂等位 = outReleasedErc20(outKeyE20, outBurnId)；
    // outKeyE20 = channelKeyOf(chainIndex, srcToken)（与合约 _key(chainIndex, token) 同构，relay.js:27 已备）
    const fn = ch.srcToken ? 'outReleasedErc20' : 'outReleased';
    const args = ch.srcToken ? [channelKeyOf(ch.chainIndex, ch.srcToken), outBurnId] : [BigInt(ch.chainIndex), outBurnId];
    const raw = await callRaw(cfg.hub.rpcUrl, cfg.hub.spBridge,
        encodeFunctionData({ abi: spBridgeAbi, functionName: fn, args }));
    return decodeFunctionResult({ abi: spBridgeAbi, functionName: fn, data: raw });
}

// pending 出向赎回重试：outReleased 命中 → done；否则用 ops.payload 里的参数重发
async function retryPendingOutReleases(env, cfg, wallet, db, ch) {
    const rows = await db.prepare(
        `select op_key, payload, attempts from ops where direction='out_release' and status='pending' and op_key like ? and (fee_state is null or fee_state not in ('out_release_stuck'))`
    ).bind(`${ch.chainIndex}:%`).all();
    for (const row of rows.results ?? []) {
        try {
            const p = JSON.parse(row.payload || '{}');
            if (!p.outBurnId) continue;
            if (await isOutReleased(cfg, ch, BigInt(p.outBurnId))) {
                await finishOp(db, 'out_release', row.op_key, 'confirmed-on-retry');
                await ensureClaim(env, cfg, wallet, db, { dir: 4, ch, seq: BigInt(p.outBurnId) }); // 已落地 → 补领奖腿
                continue;
            }
            if (row.attempts >= cfg.maxAttempts) continue; // F-018a 达上限不再重发（口径同 refund.js:183）
            await attemptOutRelease(env, cfg, wallet, db, ch, {
                outBurnId: BigInt(p.outBurnId), recipient: p.recipient, amount: BigInt(p.amount),
                buyDeadline: BigInt(p.buyDeadline ?? 0),
            }, row.op_key);
        } catch (e) {
            await failOp(db, 'out_release', row.op_key, e, cfg.maxAttempts);
        }
    }
}
