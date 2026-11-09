// 正向中继：源链 Vault.Deposit(seq) → hub StapleportBridge.executeMint（仅通道 authority 可调）。
import { encodeFunctionData, decodeEventLog, decodeFunctionResult } from 'viem';
import { vaultAbi, spBridgeAbi } from '../lib/abi.js';
import { rpc, callRaw, latestBlock, toHex } from '../lib/rpc.js';
import { sendTx } from '../lib/tx.js';
import { getCursor, setCursor, claimOp, finishOp, failOp } from '../lib/store.js';
import { to18 } from '../config.js';
import { notify } from '../notify.js';
import { channelKeyOf } from './keys.js';
import { DEPOSIT_TOPIC } from './topics.js';
import { feeAction } from './feeGate.js';
import { ensureClaim, retryPendingClaims } from './claims.js';
import { ctxWait, noteEstimateFail } from './common.js';

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
            txHash = await sendTx(cfg.hub.rpcUrl, wallet, { to: cfg.hub.spBridge, data }, cfg, 'hub');
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
            const txHash = await sendTx(cfg.hub.rpcUrl, wallet, { to: cfg.hub.spBridge, data }, cfg, 'hub');
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
