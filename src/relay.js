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
import { vaultAbi, stplBridgeAbi, DEPOSIT_EVENT, BURN_EVENT } from './lib/abi.js';
import { rpc, callRaw, latestBlock, toHex, hexToBigInt } from './lib/rpc.js';
import { sendTx, nativeBalance } from './lib/tx.js';
import { getCursor, setCursor, claimOp, finishOp, failOp } from './lib/store.js';
import { to18, from18 } from './config.js';
import { notify } from './notify.js';

// channelKey 与合约同构：keccak256(abi.encode(chainIndex, srcToken))
export const channelKeyOf = (chainIndex, srcToken) =>
    keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [BigInt(chainIndex), srcToken]));

const DEPOSIT_TOPIC = getEventSelector(parseAbiItem(`event ${DEPOSIT_EVENT}`));
const BURN_TOPIC = getEventSelector(parseAbiItem(`event ${BURN_EVENT}`));

// ---------------- 正向 ----------------

export async function relayForward(env, cfg, wallet, db) {
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
        const seq = ev.args.seq;
        const key = `${ch.chainIndex}:${seq}`;
        if (!(await claimOp(db, 'mint', key))) continue; // 他实例/前轮已抢占
        if (await isMinted(cfg, ch, seq)) {
            await finishOp(db, 'mint', key, 'already-minted');
            continue;
        }
        const stplAmount = to18(ev.args.amount, ch.srcDecimals);
        console.log(`[bridge] Deposit seq=${seq} amount=${ev.args.amount} → mint ${stplAmount} → ${ev.args.recipient}`);
        if (cfg.dryRun) {
            await finishOp(db, 'mint', key, 'dry-run');
            continue;
        }
        const data = encodeFunctionData({
            abi: stplBridgeAbi, functionName: 'executeMint',
            args: [BigInt(ch.chainIndex), seq, ch.stplToken, ev.args.recipient, stplAmount],
        });
        let txHash = null;
        try {
            txHash = await sendTx(cfg.hub.rpcUrl, wallet, { to: cfg.hub.stplBridge, data }, cfg);
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
        for (let i = 0; i < 3; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            if (await isMinted(cfg, ch, seq)) {
                await finishOp(db, 'mint', key, txHash ?? 'confirmed');
                await notify(env, { event: 'mint_sent', channel: ch.chainIndex, seq, tx: txHash });
                return;
            }
        }
        await notify(env, { event: 'mint_broadcast', channel: ch.chainIndex, seq, tx: txHash, note: '回执未确认，下轮对账' });
    })();
}

async function isMinted(cfg, ch, seq) {
    const key = channelKeyOf(ch.chainIndex, ch.srcToken);
    const raw = await callRaw(cfg.hub.rpcUrl, cfg.hub.stplBridge,
        encodeFunctionData({ abi: stplBridgeAbi, functionName: 'minted', args: [key, seq] }));
    return decodeFunctionResult({ abi: stplBridgeAbi, functionName: 'minted', data: raw });
}

// pending 重试：链上幂等位命中 → done；未命中且未超限 → 重发（参数从 Vault.deposits(seq) 现读，
// 不依赖本地留存——isolate 重启/D1 丢 payload 都能恢复）
async function retryPendingMints(env, cfg, wallet, db, ch) {
    const rows = await db.prepare(
        `select op_key, attempts from ops where direction='mint' and status='pending' and op_key like ?`
    ).bind(`${ch.chainIndex}:%`).all();
    for (const row of rows.results ?? []) {
        const seq = BigInt(row.op_key.split(':')[1]);
        try {
            if (await isMinted(cfg, ch, seq)) {
                await finishOp(db, 'mint', row.op_key, 'confirmed-on-retry');
                continue;
            }
            if (row.attempts >= cfg.maxAttempts) continue; // 已告警挂起，等人工
            const depRaw = await callRaw(ch.rpcUrl ?? cfg.srcChains[String(ch.chainIndex)].rpcUrl, ch.vault,
                encodeFunctionData({ abi: vaultAbi, functionName: 'deposits', args: [seq] }));
            const [token, , recipient, amount] = decodeFunctionResult({
                abi: vaultAbi, functionName: 'deposits', data: depRaw,
            });
            if (token.toLowerCase() !== String(ch.srcToken).toLowerCase()) continue;
            const data = encodeFunctionData({
                abi: stplBridgeAbi, functionName: 'executeMint',
                args: [BigInt(ch.chainIndex), seq, ch.stplToken, recipient, to18(amount, ch.srcDecimals)],
            });
            const txHash = await sendTx(cfg.hub.rpcUrl, wallet, { to: cfg.hub.stplBridge, data }, cfg);
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
    if (!hub.rpcUrl || !hub.stplBridge) return;
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
            address: hub.stplBridge,
            topics: [BURN_TOPIC],
            fromBlock: toHex(cursor + 1n),
            toBlock: toHex(safeTo),
        }]);
        for (const log of logs) {
            let ev;
            try {
                ev = decodeEventLog({ abi: stplBridgeAbi, data: log.data, topics: log.topics });
            } catch {
                continue;
            }
            if (ev.eventName !== 'BurnRequest') continue;
            const { seq, stplToken, chainIndex, recipient, amount } = ev.args;
            const ch = cfg.channels.find((c) =>
                BigInt(c.chainIndex) === chainIndex && String(c.stplToken).toLowerCase() === String(stplToken).toLowerCase());
            if (!ch) continue; // 非本 relayer 的通道
            const key = String(seq);
            if (!(await claimOp(db, 'release', key))) continue;
            if (await isReleased(cfg, ch, seq)) {
                await finishOp(db, 'release', key, 'already-released');
                continue;
            }
            const payload = JSON.stringify({
                seq: String(seq), srcToken: ch.srcToken, recipient, amount: String(amount),
                srcDecimals: ch.srcDecimals, chainIndex: String(ch.chainIndex),
            });
            await db.prepare('update ops set payload=? where direction=? and op_key=?')
                .bind(payload, 'release', key).run();
            await attemptRelease(env, cfg, wallet, db, ch, {
                seq, recipient, amount, srcToken: ch.srcToken, srcDecimals: ch.srcDecimals,
            }, key);
        }
        await setCursor(db, 'hub', 'burn', safeTo);
    } catch (e) {
        console.log(`[bridge] 反向 tick 异常：${String(e.message).slice(0, 120)}`);
    }
}

// 单次释放尝试：covered 通道先做 gas 覆盖预检 + 池余额预检（挂起告警，不打必败交易）
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
    // 预检 2（covered 通道）：relayer native 余额 ≥ 预估 gas×价×边际
    if (ch.covered) {
        const [bal, gasPrice] = await Promise.all([
            nativeBalance(srcRpc, wallet.address),
            rpc(srcRpc, 'eth_gasPrice', []).then(hexToBigInt),
        ]);
        const need = (gasPrice * cfg.defaultGas * cfg.gasMarginX10) / 10n;
        if (bal < need) {
            const exhausted = await failOp(db, 'release', key, 'gas coverage insufficient', cfg.maxAttempts);
            if (exhausted) {
                await notify(env, { event: 'gas_coverage_low', channel: ch.chainIndex, seq: p.seq, balance: String(bal), need: String(need) });
            }
            return;
        }
    }
    if (cfg.dryRun) {
        await finishOp(db, 'release', key, 'dry-run');
        return;
    }
    const data = encodeFunctionData({
        abi: vaultAbi, functionName: 'executeRelease',
        args: [BigInt(p.seq), p.srcToken, p.recipient, amountSrc],
    });
    try {
        const txHash = await sendTx(srcRpc, wallet, { to: ch.vault, data }, cfg);
        console.log(`[bridge] executeRelease 广播: ${txHash ?? '(dry)'}`);
        await ctxWait(env, releasedSettle(env, cfg, db, ch, key, p.seq, txHash));
    } catch (e) {
        console.log(`[bridge] executeRelease 异常 seq=${p.seq}: ${String(e.message).slice(0, 200)}`);
        const exhausted = await failOp(db, 'release', key, e, cfg.maxAttempts);
        if (exhausted) {
            await notify(env, { event: 'release_stuck', channel: ch.chainIndex, seq: p.seq, error: String(e.message).slice(0, 200) });
        }
    }
}

function releasedSettle(env, cfg, db, ch, key, seq, txHash) {
    return (async () => {
        for (let i = 0; i < 3; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            if (await isReleased(cfg, ch, seq)) {
                await finishOp(db, 'release', key, txHash ?? 'confirmed');
                await notify(env, { event: 'release_sent', channel: ch.chainIndex, seq, tx: txHash });
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
        `select op_key, payload, attempts from ops where direction='release' and status='pending'`
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
                continue;
            }
            if (row.attempts >= cfg.maxAttempts) continue;
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
