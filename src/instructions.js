// 通用指令信封腿（v2 设计稿 §2.1/§3.3）：轮询源链 outbox 的 Instruction 事件 →
// 游标记账（per outbox 地址持久化，格式照 relay.js `src:${chainIndex}` 先例）→
// 过期预判（deadline!=0 && dst now>deadline → 源链 outbox.refund(seq)，不组目标链 tx）→
// 未过期组目标链 tx：registry 槽位填价 → target.call(data,value) → 成功记 delivered
// + fee>0 时 outbox.claim(seq)。扫 Refunded 事件 → 对账终态（fee 裁决闭环）。
//
// 与既有五腿共存（§2.3：worker tick 序=既有五腿→relayInstructions）：本文件独立新增，
// 不改 worker.js/relay.js 既有腿一行。
//
// 幂等/重试照既有 D1 模式：claimOp 抢占 + 链上 instructions(seq).state 终态对账
// （FeeState 0=Pending/1=Claimed/2=Refunded）+ 广播后短轮询；失败 failOp 计次。
// 启动对拍拒启（§3.1）：registry target 与链上 targetRegistry 不一致 → 告警并整腿停。
import { encodeFunctionData, decodeEventLog, decodeFunctionResult, parseAbiItem, getEventSelector } from 'viem';
import { instructionOutboxAbi, INSTRUCTION_EVENT, REFUNDED_EVENT } from './lib/abi.js';
import { rpc, callRaw, latestBlock, toHex } from './lib/rpc.js';
import { sendTx } from './lib/tx.js';
import { getCursor, setCursor, claimOp, finishOp, failOp } from './lib/store.js';
import { fetchPrice18 } from './lib/price.js';
import { loadInstructionRegistry } from './lib/instructions-registry.js';
import { notify } from './notify.js';

// 哨兵（设计稿 §3.3 / InstructionOutbox.SENTINEL_PRICE18，逐字一致）
export const SENTINEL_PRICE18 = '0x7072316365000000000000000000000000000000000000000000000000000001';
const INSTRUCTION_TOPIC = getEventSelector(parseAbiItem(`event ${INSTRUCTION_EVENT}`));
const REFUNDED_TOPIC = getEventSelector(parseAbiItem(`event ${REFUNDED_EVENT}`));

// op 名（设计稿 §0.3）：env_exec 转发 / env_refund 过期退款 / env_claim 成功领奖。
export const OP = { exec: 'env_exec', refund: 'env_refund', claim: 'env_claim' };

// op_key = env:${dstChain}:${outboxAddr}:${seq}（同 outbox 跨目标链不撞 seq）
export const envKeyOf = (dstChain, outboxAddr, seq) =>
    `env:${String(dstChain)}:${String(outboxAddr).toLowerCase()}:${String(seq)}`;

// 槽位填充（设计稿 §3.3）：offset = calldata 绝对字节偏移（含 4 字节 selector）。
// 命中 SENTINEL → 覆写 32 字节；非 SENTINEL → 告警并跳过该槽（不错位覆写，语义=设计稿）；
// 某 kind 无价 → error（调用方本轮 skip 留 last_error）。纯函数，供单测。
export function fillSlots(dataHex, slots, prices) {
    const res = { data: String(dataHex), filled: 0, skipped: [], error: null };
    let d = res.data;
    if (!/^0x[0-9a-fA-F]*$/.test(d)) { res.error = 'data not hex'; return res; }
    for (const slot of slots ?? []) {
        const offset = Number(slot.offset);
        const kind = String(slot.kind);
        if (!Number.isInteger(offset) || offset < 0) { res.skipped.push({ kind, offset: slot.offset, reason: 'bad offset' }); continue; }
        const start = 2 + offset * 2;
        const end = start + 64;
        if (d.length < end) { res.skipped.push({ kind, offset, reason: 'out of range' }); continue; }
        if (d.slice(start, end).toLowerCase() !== SENTINEL_PRICE18.slice(2)) {
            console.warn(`[bridge] 槽位错位 offset=${offset} 非 SENTINEL（kind=${kind}），跳过本槽填充`);
            res.skipped.push({ kind, offset, reason: 'not sentinel' });
            continue;
        }
        const value = prices?.[kind];
        if (value == null) { res.error = `no price for kind ${kind}`; return res; }
        const hex = BigInt(value).toString(16).padStart(64, '0');
        d = d.slice(0, start) + hex + d.slice(end);
        res.filled++;
    }
    res.data = d;
    return res;
}

async function savePayload(db, direction, key, p) {
    await db.prepare('update ops set payload=?, updated_at=? where direction=? and op_key=?')
        .bind(JSON.stringify(p), Date.now(), direction, key).run();
}

async function setLastError(db, direction, key, err) {
    await db.prepare('update ops set last_error=?, updated_at=? where direction=? and op_key=?')
        .bind(String(err).slice(0, 500), Date.now(), direction, key).run();
}

// 该 outbox 上该 seq 的信封终态（0 Pending/1 Claimed/2 Refunded）；读失败 → null（放行重试）
async function readState(rpcUrl, outboxAddr, seq) {
    const raw = await callRaw(rpcUrl, outboxAddr,
        encodeFunctionData({ abi: instructionOutboxAbi, functionName: 'instructions', args: [BigInt(seq)] }));
    const ins = decodeFunctionResult({ abi: instructionOutboxAbi, functionName: 'instructions', data: raw });
    return Number(Array.isArray(ins) ? ins[9] : ins.state);
}

// 启动对拍（§3.1）：registry target vs 链上 outbox.targetRegistry 逐条比对。
// 任一不一致 / 读链失败（未部署/不可达）→ 拒启（返回 false），非静默 skip。
export async function verifyRegistry(env, cfg, reg) {
    for (const ob of reg.outboxes) {
        const ch = reg.chains[ob.chainIndex];
        if (!ch?.rpcUrl) { console.error(`[bridge] 指令 registry 对拍：outbox chain ${ob.chainIndex} 缺 rpcUrl → 拒启`); return false; }
        for (const [targetId, t] of Object.entries(reg.targets)) {
            if (String(t.srcChain) !== String(ob.chainIndex)) continue;
            let decoded;
            try {
                const raw = await callRaw(ch.rpcUrl, ob.addr,
                    encodeFunctionData({ abi: instructionOutboxAbi, functionName: 'targetRegistry', args: [targetId] }));
                decoded = decodeFunctionResult({ abi: instructionOutboxAbi, functionName: 'targetRegistry', data: raw });
            } catch (e) {
                console.error(`[bridge] 指令 registry 对拍读链失败 outbox=${ob.addr} targetId=${targetId}：${String(e.message).slice(0, 120)} → 拒启`);
                return false;
            }
            const onDst = Array.isArray(decoded) ? decoded[0] : decoded.dstChainIndex;
            const onAddr = Array.isArray(decoded) ? decoded[1] : decoded.addr;
            const onReg = Array.isArray(decoded) ? decoded[2] : decoded.registered;
            if (!onReg || String(onAddr).toLowerCase() !== t.addr || String(onDst) !== String(t.dstChain)) {
                console.error(`[bridge] 指令 registry 对拍不一致 targetId=${targetId}：链上 dst=${onDst} addr=${onAddr} registered=${onReg}，配置 dst=${t.dstChain} addr=${t.addr}`);
                await notify(env, {
                    event: 'instruction_registry_mismatch', targetId,
                    onChain: { dst: String(onDst), addr: onAddr, registered: !!onReg },
                    config: { dst: String(t.dstChain), addr: t.addr },
                });
                return false;
            }
        }
    }
    return true;
}

// ================= 转发 / 退款 / 领奖三动作 =================

async function attemptExec(env, cfg, wallet, db, reg, ob, t, key, p) {
    if (cfg.dryRun) { await finishOp(db, OP.exec, key, 'dry-run'); return; }
    const dstRpc = reg.chains[String(t.dstChain)]?.rpcUrl;
    try {
        // T1 域代 patch（T6 授权）：value 类型需同时满足 precheck(JSON-safe) 与 viem 签名(bigint)，
        // 二者互斥；零值省略（设计 §1.2 初期买/卖 value 恒 0）→ precheck 落 '0x0'、签名落 0n。
        const envValue = BigInt(p.value ?? 0) === 0n ? undefined : BigInt(p.value ?? 0);
        const txHash = await sendTx(dstRpc, wallet, { to: t.addr, data: p.data, value: envValue }, cfg);
        if (txHash == null) { await setLastError(db, OP.exec, key, 'estimate-fail (target call skipped)'); return; }
        console.log(`[bridge] env_exec 转发广播: ${txHash} targetId=${p.targetId} seq=${p.seq}`);
        await finishOp(db, OP.exec, key, txHash);
        await notify(env, { event: 'instruction_exec_sent', targetId: p.targetId, seq: p.seq, tx: txHash });
        if (BigInt(p.fee ?? 0) > 0n) await claimInstruction(env, cfg, wallet, db, reg, ob, p.seq);
    } catch (e) {
        console.log(`[bridge] env_exec 转发异常 seq=${p.seq}: ${String(e.message).slice(0, 200)}`);
        const exhausted = await failOp(db, OP.exec, key, e, cfg.maxAttempts);
        if (exhausted) await notify(env, { event: 'instruction_exec_stuck', targetId: p.targetId, seq: p.seq, error: String(e.message).slice(0, 200) });
    }
}

// 成功腿领奖：源链 outbox.claim(seq)（authority=relayer）。终态互斥幂等——已 Claimed/Refunded
// 会 revert，视为已结清不再重试。
async function claimInstruction(env, cfg, wallet, db, reg, ob, seq) {
    const ckey = `${ob.chainIndex}:${ob.addr}:${String(seq)}`;
    if (!(await claimOp(db, OP.claim, ckey))) return;
    await savePayload(db, OP.claim, ckey, { seq: String(seq), outboxChain: String(ob.chainIndex), outboxAddr: ob.addr });
    if (cfg.dryRun) { await finishOp(db, OP.claim, ckey, 'dry-run'); return; }
    const ch = reg.chains[ob.chainIndex];
    const data = encodeFunctionData({ abi: instructionOutboxAbi, functionName: 'claim', args: [BigInt(seq)] });
    try {
        const txHash = await sendTx(ch.rpcUrl, wallet, { to: ob.addr, data }, cfg);
        if (txHash == null) { await setLastError(db, OP.claim, ckey, 'estimate-fail'); return; }
        await finishOp(db, OP.claim, ckey, txHash);
        await notify(env, { event: 'instruction_claim_sent', seq: String(seq), tx: txHash });
    } catch (e) {
        await finishOp(db, OP.claim, ckey, 'settled-or-reverted');
        console.log(`[bridge] env_claim seq=${seq} 未成功（多为他方/终态已结清）：${String(e.message).slice(0, 160)}`);
    }
}

// 过期腿：源链 outbox.refund(seq)（合约自守 require(now>=deadline)，未到期 revert → 保持 pending 重试）。
async function attemptRefund(env, cfg, wallet, db, reg, ob, key, seq) {
    if (cfg.dryRun) { await finishOp(db, OP.refund, key, 'dry-run'); return; }
    const ch = reg.chains[ob.chainIndex];
    const data = encodeFunctionData({ abi: instructionOutboxAbi, functionName: 'refund', args: [BigInt(seq)] });
    try {
        const txHash = await sendTx(ch.rpcUrl, wallet, { to: ob.addr, data }, cfg);
        if (txHash == null) { await setLastError(db, OP.refund, key, 'estimate-fail (deadline not reached?)'); return; }
        console.log(`[bridge] env_refund 广播: ${txHash} seq=${seq}`);
        await finishOp(db, OP.refund, key, txHash);
        await notify(env, { event: 'instruction_refund_sent', seq: String(seq), tx: txHash });
    } catch (e) {
        console.log(`[bridge] env_refund 异常 seq=${seq}: ${String(e.message).slice(0, 200)}`);
        const exhausted = await failOp(db, OP.refund, key, e, cfg.maxAttempts);
        if (exhausted) await notify(env, { event: 'instruction_refund_stuck', seq: String(seq), error: String(e.message).slice(0, 200) });
    }
}

// ================= 事件处理 =================

async function handleExec(env, cfg, wallet, db, reg, ob, t, p) {
    const key = envKeyOf(t.dstChain, ob.addr, p.seq);
    if (!(await claimOp(db, OP.exec, key))) return; // 已处理/他实例抢占
    // 取价：本指令 slots 涉及的 kind 各取一次
    const prices = {};
    try {
        for (const kind of [...new Set((t.slots ?? []).map((s) => s.kind))]) prices[kind] = await fetchPrice18(env, cfg, kind);
    } catch (e) {
        await setLastError(db, OP.exec, key, e.message);
        return; // 未知 kind 等配置错，保持 pending 待修
    }
    const filled = fillSlots(p.data, t.slots, prices);
    if (filled.error) {
        console.log(`[bridge] 指令 seq=${p.seq} 取价失败（${filled.error}），本轮 skip 留 last_error`);
        await setLastError(db, OP.exec, key, filled.error);
        return;
    }
    const payload = {
        seq: String(p.seq), targetId: String(p.targetId),
        outboxChain: String(ob.chainIndex), outboxAddr: ob.addr,
        dstChain: String(t.dstChain), dstAddr: t.addr, data: filled.data,
        value: String(p.value ?? 0n), fee: String(p.fee ?? 0n), deadline: String(p.deadline ?? 0n),
        slotFilled: filled.filled, slotSkipped: filled.skipped,
    };
    await savePayload(db, OP.exec, key, payload);
    await attemptExec(env, cfg, wallet, db, reg, ob, t, key, payload);
}

async function handleRefund(env, cfg, wallet, db, reg, ob, t, p) {
    const key = envKeyOf(t.dstChain, ob.addr, p.seq);
    if (!(await claimOp(db, OP.refund, key))) return;
    await savePayload(db, OP.refund, key, {
        seq: String(p.seq), targetId: String(p.targetId),
        outboxChain: String(ob.chainIndex), outboxAddr: ob.addr, dstChain: String(t.dstChain),
    });
    await attemptRefund(env, cfg, wallet, db, reg, ob, key, BigInt(p.seq));
}

async function handleInstruction(env, cfg, wallet, db, reg, ob, args) {
    const { seq, targetId, data, value, fee, deadline, priceSnapshot, refundSpec, payer } = args;
    const t = reg.targets[String(targetId).toLowerCase()];
    if (!t) { console.warn(`[bridge] 指令 seq=${seq} targetId=${targetId} 未在 registry（跳过）`); return; }
    if (!reg.chains[String(t.dstChain)]?.rpcUrl) { console.warn(`[bridge] 指令 seq=${seq} dstChain=${t.dstChain} 缺 rpcUrl（跳过）`); return; }
    const dl = Number(deadline ?? 0n);
    const expired = dl !== 0 && Math.floor(Date.now() / 1000) > dl;
    if (expired) return handleRefund(env, cfg, wallet, db, reg, ob, t, { seq, targetId });
    return handleExec(env, cfg, wallet, db, reg, ob, t, {
        seq, targetId, data, value, fee, deadline, priceSnapshot, refundSpec, payer,
    });
}

// 单 outbox 面扫描：Instruction（转发/退款）+ Refunded（终态对账），单游标 per outbox 地址。
async function scanOutbox(env, cfg, wallet, db, reg, ob) {
    const ch = reg.chains[ob.chainIndex];
    if (!ch?.rpcUrl) { console.error(`[bridge] 指令 outbox ${ob.chainIndex} 缺 rpcUrl，跳过`); return; }
    const curKey = `src:${ob.chainIndex}`;
    const curName = `instruction:${ob.addr}`;
    const head = await latestBlock(ch.rpcUrl);
    const safeTo = head - BigInt(ch.confirmations ?? 3);
    const cursor = await getCursor(db, curKey, curName);
    if (cursor === null) {
        await setCursor(db, curKey, curName, safeTo);
        console.log(`[bridge] 指令 outbox ${ob.chainIndex}/${ob.addr} 游标基线 → ${safeTo}`);
        return;
    }
    if (safeTo <= cursor) return;

    const base = { address: ob.addr, fromBlock: toHex(cursor + 1n), toBlock: toHex(safeTo) };
    const [instrLogs, refundLogs] = await Promise.all([
        rpc(ch.rpcUrl, 'eth_getLogs', [{ ...base, topics: [INSTRUCTION_TOPIC] }]),
        rpc(ch.rpcUrl, 'eth_getLogs', [{ ...base, topics: [REFUNDED_TOPIC] }]),
    ]);

    // 先对账 Refunded（终态）：该 outbox+seq 的 env_* pending 标 done
    for (const log of refundLogs) {
        let ev;
        try { ev = decodeEventLog({ abi: instructionOutboxAbi, data: log.data, topics: log.topics }); } catch { continue; }
        if (ev.eventName !== 'Refunded') continue;
        await db.prepare(`update ops set status='done', updated_at=? where direction like 'env_%' and op_key like ?`)
            .bind(Date.now(), `env:%:${ob.addr}:${ev.args.seq}`).run();
    }

    for (const log of instrLogs) {
        let ev;
        try { ev = decodeEventLog({ abi: instructionOutboxAbi, data: log.data, topics: log.topics }); } catch { continue; }
        if (ev.eventName !== 'Instruction') continue;
        await handleInstruction(env, cfg, wallet, db, reg, ob, ev.args);
    }
    await setCursor(db, curKey, curName, safeTo);
}

// pending 重试（每 tick 一次）：env_exec 用 ops.payload 重填重发、env_refund/env_claim 重发；
// 终态对账（instructions.state != Pending → done）优先短路。
async function retryPendingInstructions(env, cfg, wallet, db, reg) {
    const rows = await db.prepare(
        `select direction, op_key, payload from ops where status='pending' and direction like 'env_%'`
    ).all();
    for (const row of rows.results ?? []) {
        try {
            const p = JSON.parse(row.payload || '{}');
            const ob = reg.outboxes.find((o) => o.addr === String(p.outboxAddr).toLowerCase());
            if (!ob) { await failOp(db, row.direction, row.op_key, 'outbox not in registry', cfg.maxAttempts); continue; }
            if (row.direction === OP.exec) {
                const t = reg.targets[String(p.targetId).toLowerCase()];
                if (!t) { await failOp(db, row.direction, row.op_key, 'target not in registry', cfg.maxAttempts); continue; }
                const st = await readState(reg.chains[ob.chainIndex].rpcUrl, ob.addr, p.seq).catch(() => null);
                if (st === 1 || st === 2) { await finishOp(db, row.direction, row.op_key, `settled-on-retry(${st})`); continue; }
                await attemptExec(env, cfg, wallet, db, reg, ob, t, row.op_key, p);
            } else if (row.direction === OP.refund) {
                await attemptRefund(env, cfg, wallet, db, reg, ob, row.op_key, BigInt(p.seq));
            } else if (row.direction === OP.claim) {
                const st = await readState(reg.chains[ob.chainIndex].rpcUrl, ob.addr, p.seq).catch(() => null);
                if (st === 1 || st === 2) { await finishOp(db, row.direction, row.op_key, 'settled-on-retry'); continue; }
                await claimInstruction(env, cfg, wallet, db, reg, ob, p.seq);
            }
        } catch (e) {
            await failOp(db, row.direction, row.op_key, e, cfg.maxAttempts);
        }
    }
}

// tick 入口（worker.js 尾挂）：空 registry 空转；对拍不一致拒启；先 pending 重试再逐 outbox 扫。
export async function relayInstructions(env, cfg, wallet, db) {
    let reg;
    try { reg = loadInstructionRegistry(env); }
    catch (e) { console.error(`[bridge] 指令 registry 装载失败：${String(e.message).slice(0, 160)}`); return; }
    if (!reg.outboxes.length) return; // 未配置 = 空转（零改既有五腿行为）
    if (!(await verifyRegistry(env, cfg, reg))) {
        console.error('[bridge] 指令 registry 与链上对拍不一致，通用腿本轮拒启');
        return;
    }
    try { await retryPendingInstructions(env, cfg, wallet, db, reg); }
    catch (e) { console.log(`[bridge] 指令 pending 重试异常：${String(e.message).slice(0, 120)}`); }
    for (const ob of reg.outboxes) {
        try { await scanOutbox(env, cfg, wallet, db, reg, ob); }
        catch (e) { console.log(`[bridge] 指令 outbox ${ob.chainIndex}/${ob.addr} 扫描异常：${String(e.message).slice(0, 120)}`); }
    }
}
