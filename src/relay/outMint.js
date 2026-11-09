// 出向正向：hub LockOut(seq) → 外链 OutVault.executeOutMint（native/erc20 分族）。
import { encodeFunctionData, decodeEventLog, decodeFunctionResult } from 'viem';
import { spBridgeAbi, outVaultAbi } from '../lib/abi.js';
import { rpc, callRaw, latestBlock, toHex } from '../lib/rpc.js';
import { sendTx } from '../lib/tx.js';
import { getCursor, setCursor, claimOp, finishOp, failOp } from '../lib/store.js';
import { hubConfirmationsOf } from '../config.js';
import { notify } from '../notify.js';
import { channelKeyOf, outKeyOf } from './keys.js';
import { LOCKOUT_TOPIC } from './topics.js';
import { feeAction } from './feeGate.js';
import { ensureClaim } from './claims.js';
import { ctxWait, noteEstimateFail } from './common.js';

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
        const conf = hubConfirmationsOf(env); // SRC_CHAINS hub 确认数（经 config vars 解析缓存，L1-3）
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
        const txHash = await sendTx(srcRpc, wallet, { to: ch.vault, data }, cfg, 'src');
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
