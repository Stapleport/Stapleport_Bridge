// 领奖腿（§3.4 direction ×4）：描述/单次尝试/回执短轮询/成功即补领/pending 重试。
import { encodeFunctionData } from 'viem';
import { vaultAbi, spBridgeAbi, outVaultAbi } from '../lib/abi.js';
import { callRaw } from '../lib/rpc.js';
import { sendTx } from '../lib/tx.js';
import { claimOp, finishOp, failOp, setFeeState, bumpStuckCount } from '../lib/store.js';
import { readFees } from '../lib/fee.js';
import { notify } from '../notify.js';
import { isAdjudicatedSettled } from './adjudication.js';
import { ctxWait } from './common.js';

// ---- 领奖腿（§3.4 新 direction ×5；幂等 = claimOp + Fees getter state==2）----

// 领奖描述（域/编码/幂等视图）。keyLayer = 该腿签名钥层（lib/tx.js resolveSigner）：
//   dir1 claimDepositFee 在 spoke vault（spoke authority）→ src；
//   dir2 claimBurnFee 在 hub，权限槽 feeClaimAuthority（独立于通道 authority）→ fee；
//   dir3 claimOutLockFee 在 hub，守 outChannel authority → hub；
//   dir4 claimOutBurnFee 在 spoke OutVault（spoke authority）→ src。
function claimSpec(cfg, dir, ch, erc20, seq) {
    const hub = cfg.hub;
    if (dir === 1) {
        return {
            direction: 'fee_claim_mint', key: `${ch.chainIndex}:${seq}`, chainIndex: String(ch.chainIndex),
            keyLayer: 'src',
            rpcUrl: ch.rpcUrl, to: ch.vault, abi: vaultAbi, fn: 'claimDepositFee', args: [seq],
            viewFn: 'depositFees', viewArgs: [seq],
            payload: { dir: 1, chainIndex: String(ch.chainIndex), seq: String(seq) },
        };
    }
    if (dir === 2) {
        return {
            direction: 'fee_claim_release', key: String(seq), chainIndex: String(ch?.chainIndex ?? ''),
            keyLayer: 'fee',
            rpcUrl: hub.rpcUrl, to: hub.spBridge, abi: spBridgeAbi, fn: 'claimBurnFee', args: [seq],
            viewFn: 'burnFees', viewArgs: [seq],
            payload: { dir: 2, seq: String(seq) },
        };
    }
    if (dir === 3) {
        return {
            direction: erc20 ? 'fee_claim_out_mint_e20' : 'fee_claim_out_mint', key: `${ch.chainIndex}:${seq}`,
            chainIndex: String(ch.chainIndex),
            keyLayer: 'hub',
            rpcUrl: hub.rpcUrl, to: hub.spBridge, abi: spBridgeAbi,
            fn: erc20 ? 'claimOutLockFeeErc20' : 'claimOutLockFee', args: [seq],
            viewFn: erc20 ? 'outLockFeesErc20' : 'outLockFees', viewArgs: [seq],
            payload: { dir: 3, erc20: !!erc20, chainIndex: String(ch.chainIndex), seq: String(seq) },
        };
    }
    return {
        direction: 'fee_claim_out_release', key: `${ch.chainIndex}:${seq}`, chainIndex: String(ch.chainIndex),
        keyLayer: 'src',
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
        const txHash = await sendTx(spec.rpcUrl, wallet, { to: spec.to, data }, cfg, spec.keyLayer ?? 'base');
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
export async function retryPendingClaims(env, cfg, wallet, db) {
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
            if (st.state === 1) {
                // FeeState.Refunded：费已走退款腿分账（pad→feeRecipient、reward→payer），领奖腿不适用
                //（合约 claimXxxFee 会 revert "fee settled"）。终态关闭，防 re-arm 后每轮空发必败交易。
                await finishOp(db, row.direction, row.op_key, 'refunded-not-claimable');
                continue;
            }
            if (row.attempts >= cfg.maxAttempts) continue; // 领奖腿无二级 deadline，超限挂人工（现役退款腿同款）
            await attemptClaim(env, cfg, wallet, db, spec);
        } catch (e) {
            console.log(`[bridge] claim 重试异常 key=${row.op_key}: ${String(e.message).slice(0, 160)}`);
        }
    }
}
