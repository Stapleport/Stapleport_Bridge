// 反向中继：hub StapleportBridge.BurnRequest(seq) → 源链 Vault.executeRelease（outId=seq）。
import { encodeFunctionData, decodeEventLog, decodeFunctionResult } from 'viem';
import { vaultAbi, spBridgeAbi } from '../lib/abi.js';
import { rpc, callRaw, latestBlock, toHex } from '../lib/rpc.js';
import { sendTx } from '../lib/tx.js';
import { getCursor, setCursor, claimOp, finishOp, failOp } from '../lib/store.js';
import { from18, hubConfirmationsOf } from '../config.js';
import { notify } from '../notify.js';
import { BURN_TOPIC } from './topics.js';
import { feeAction } from './feeGate.js';
import { ensureClaim } from './claims.js';
import { ctxWait, noteEstimateFail } from './common.js';

// ---------------- 反向 ----------------

export async function relayReverse(env, cfg, wallet, db) {
    const hub = cfg.hub;
    if (!hub.rpcUrl || !hub.spBridge) return;
    try {
        await retryPendingReleases(env, cfg, wallet, db);
        const head = await latestBlock(hub.rpcUrl);
        const conf = hubConfirmationsOf(env); // SRC_CHAINS hub 确认数（经 config vars 解析缓存，L1-3）
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
        const txHash = await sendTx(srcRpc, wallet, { to: ch.vault, data }, cfg, 'src');
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
