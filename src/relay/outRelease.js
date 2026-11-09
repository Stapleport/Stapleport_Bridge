// 出向反向：外链 BurnOut → hub executeOutRelease / executeOutReleaseERC20。
import { encodeFunctionData, decodeEventLog, decodeFunctionResult } from 'viem';
import { spBridgeAbi, outVaultAbi } from '../lib/abi.js';
import { rpc, callRaw, latestBlock, toHex } from '../lib/rpc.js';
import { sendTx } from '../lib/tx.js';
import { getCursor, setCursor, claimOp, finishOp, failOp } from '../lib/store.js';
import { notify } from '../notify.js';
import { channelKeyOf, outKeyOf } from './keys.js';
import { BURNOUT_TOPIC } from './topics.js';
import { feeAction } from './feeGate.js';
import { ensureClaim } from './claims.js';
import { ctxWait, noteEstimateFail } from './common.js';

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
        const txHash = await sendTx(hubRpc, wallet, { to: cfg.hub.spBridge, data }, cfg, 'hub');
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
    // outKeyE20 = channelKeyOf(chainIndex, srcToken)（与合约 _key(chainIndex, token) 同构，见 ./keys.js 导出 channelKeyOf）
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
