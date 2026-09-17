// D1 游标与 ops 幂等表操作。合约层幂等（minted/released/outId）是第一道保险，
// 这里是第二道：D1 丢了最多多烧几笔被合约幂等拦下的空交易，不会双铸/双放。
export async function getCursor(db, chainId, name) {
    const r = await db.prepare('select last_block from cursors where chain_id=? and name=?')
        .bind(chainId, name).first();
    return r === null ? null : BigInt(r.last_block);
}

export async function setCursor(db, chainId, name, block) {
    await db.prepare(
        `insert into cursors (chain_id, name, last_block, updated_at) values (?,?,?,?)
         on conflict (chain_id, name) do update set last_block=excluded.last_block, updated_at=excluded.updated_at`
    ).bind(chainId, name, block.toString(), Date.now()).run();
}

// 抢占 op：insert 成功 = 本实例拿到处理权（多实例/重试天然去重）
export async function claimOp(db, direction, key) {
    const now = Date.now();
    const res = await db.prepare(
        `insert or ignore into ops (direction, op_key, status, created_at, updated_at) values (?,?, 'pending', ?, ?)`
    ).bind(direction, key, now, now).run();
    return res.meta.changes > 0;
}

export async function finishOp(db, direction, key, txHash) {
    await db.prepare('update ops set status=? , tx_hash=?, updated_at=? where direction=? and op_key=?')
        .bind('done', txHash ?? null, Date.now(), direction, key).run();
}

// 失败计次；返回是否已超重试上限（超了发告警，行保持 pending 便于人工处理后自动恢复）
export async function failOp(db, direction, key, err, maxAttempts) {
    const row = await db.prepare('select attempts from ops where direction=? and op_key=?')
        .bind(direction, key).first();
    const attempts = (row?.attempts ?? 0) + 1;
    await db.prepare('update ops set attempts=?, last_error=?, updated_at=? where direction=? and op_key=?')
        .bind(attempts, String(err).slice(0, 500), Date.now(), direction, key).run();
    return attempts >= maxAttempts;
}

export async function opAttempts(db, direction, key) {
    const r = await db.prepare('select attempts from ops where direction=? and op_key=?')
        .bind(direction, key).first();
    return r?.attempts ?? 0;
}

// ---- onboard（E流 自动 onboarding 状态机，表见 migrations/0002_onboard.sql）----
// status = 当前该执行的动作：registered(查/注册索引) → indexed(spoke setChainIndex)
// → channeled(hub 开通道) → awaiting_stake(押金人工门) → active(终态，派生层取用)

// 建行幂等（INSERT OR IGNORE 抢占）+ 回读当前行——cron 并发下两边都拿到同一行推进
export async function ensureOnboardRow(db, chainId) {
    await db.prepare(
        `insert or ignore into onboard (chain_id, status, chain_index, detail, updated_at) values (?, 'registered', null, null, ?)`
    ).bind(chainId, Date.now()).run();
    return await db.prepare('select * from onboard where chain_id=?').bind(chainId).first();
}

// 状态 CAS：只有从 fromStatus 的推进生效（并发 isolate 下不会互相超越/回退）
export async function setOnboardStatus(db, chainId, fromStatus, toStatus) {
    const res = await db.prepare('update onboard set status=?, updated_at=? where chain_id=? and status=?')
        .bind(toStatus, Date.now(), chainId, fromStatus).run();
    return res.meta.changes > 0;
}

export async function setOnboardIndex(db, chainId, chainIndex) {
    await db.prepare('update onboard set chain_index=?, updated_at=? where chain_id=?')
        .bind(String(chainIndex), Date.now(), chainId).run();
}

export async function setOnboardDetail(db, chainId, detail) {
    await db.prepare('update onboard set detail=?, updated_at=? where chain_id=?')
        .bind(JSON.stringify(detail), Date.now(), chainId).run();
}

export async function listOnboardByStatus(db, status) {
    const r = await db.prepare('select * from onboard where status=?').bind(status).all();
    return r.results ?? [];
}

// /health 摘要用：全量行的轻量投影
export async function listOnboard(db) {
    const r = await db.prepare('select chain_id, status, chain_index, updated_at from onboard order by chain_id').all();
    return r.results ?? [];
}
