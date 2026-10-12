// 内存版 D1 测试垫片（Stapleport_Bridge 仓内唯一一件，供 test/*.test.mjs 共同 import）。
// 消费者：test/fee.test.mjs（MemD1，ops 表）、test/onboarding.test.mjs（OnboardD1，onboard 表）。
// 基类 Stmt 收敛公共骨架（prepare 归一化 + bind）；两个子类各按自己的表手写分支，键/参序逐分支对齐真 SQL。
//
// 正典指针：Stapleport_worker/Stapleport_Faucet/packages/worker/test/helpers/d1.mjs（node:sqlite + schema.sql 驱动）。
// 差异一句话：本件是 Map 版、只装本仓 store.js 用到的语句、无 batch()（Faucet 版走真 SQL 引擎、schema 驱动）。
// 跨仓不物理合并（各仓独立 pnpm）；形态升级以 Faucet 正典为准。

// 公共骨架：sql 归一化（多空白折叠）+ bind 存参。
class Stmt {
    constructor(db, sql) { this.db = db; this.sql = sql.replace(/\s+/g, ' ').trim(); this.args = []; }
    bind(...a) { this.args = a; return this; }
}

// ops 表（store.js 计数器/费率面）；键 = `direction|opKey`
class OpsStmt extends Stmt {
    async first() {
        const s = this.sql, a = this.args;
        if (s.startsWith('select fee_attempts from ops')) { const r = this.db.rows.get(`${a[0]}|${a[1]}`); return r ? { fee_attempts: r.fee_attempts } : null; }
        if (s.startsWith('select attempts from ops')) { const r = this.db.rows.get(`${a[0]}|${a[1]}`); return r ? { attempts: r.attempts } : null; }
        return null;
    }
    async all() { return { results: [] }; }
    async run() {
        const s = this.sql, a = this.args; this.db.changes = 0;
        if (s.startsWith('update ops set fee_attempts=fee_attempts+1')) {
            const r = this.db.rows.get(`${a[1]}|${a[2]}`); if (r) { r.fee_attempts = (r.fee_attempts ?? 0) + 1; this.db.changes = 1; }
        } else if (s.startsWith('update ops set fee_state=')) {
            const r = this.db.rows.get(`${a[2]}|${a[3]}`); if (r) { r.fee_state = a[0]; this.db.changes = 1; }
        } else if (s.startsWith('update ops set payload=')) {
            const r = this.db.rows.get(`${a[1]}|${a[2]}`); if (r) { r.payload = a[0]; this.db.changes = 1; }
        } else if (s.startsWith('insert or ignore into ops')) {
            const k = `${a[0]}|${a[1]}`; if (!this.db.rows.has(k)) { this.db.rows.set(k, { status: 'pending', attempts: 0, fee_state: null, fee_attempts: 0 }); this.db.changes = 1; }
        }
        return { meta: { changes: this.db.changes } };
    }
}

// onboard 表（store.js onboarding 状态机）；键 = String(chainId)
class OnboardStmt extends Stmt {
    async run() {
        const [sql, a] = [this.sql, this.args];
        const meta = (ok) => ({ meta: { changes: ok ? 1 : 0 } });
        if (sql.startsWith('insert or ignore into onboard')) {
            const key = String(a[0]);
            const inserted = !this.db.rows.has(key);
            if (inserted) {
                this.db.rows.set(key, { chain_id: a[0], status: 'registered', chain_index: null, detail: null, updated_at: a[1] });
            }
            return meta(inserted);
        }
        if (sql.startsWith('update onboard set status')) {
            const row = this.db.rows.get(String(a[2]));
            const ok = Boolean(row) && row.status === a[3];
            if (ok) { row.status = a[0]; row.updated_at = a[1]; }
            return meta(ok);
        }
        if (sql.startsWith('update onboard set chain_index')) {
            const row = this.db.rows.get(String(a[2]));
            if (row) { row.chain_index = String(a[0]); row.updated_at = a[1]; }
            return meta(Boolean(row));
        }
        if (sql.startsWith('update onboard set detail')) {
            const row = this.db.rows.get(String(a[2]));
            if (row) { row.detail = a[0]; row.updated_at = a[1]; }
            return meta(Boolean(row));
        }
        throw new Error(`d1 shim: unhandled ${sql}`);
    }
    async first() {
        if (this.sql.startsWith('select * from onboard where chain_id=?')) {
            return this.db.rows.get(String(this.args[0])) ?? null;
        }
        return null;
    }
    async all() {
        if (this.sql.startsWith('select * from onboard where status=?')) {
            return { results: [...this.db.rows.values()].filter((r) => r.status === this.args[0]) };
        }
        if (this.sql.startsWith('select chain_id, status, chain_index, updated_at from onboard')) {
            return { results: [...this.db.rows.values()].map((r) => ({ ...r })) };
        }
        return { results: [] };
    }
}

export class MemD1 {
    constructor() { this.rows = new Map(); this.changes = 0; }
    prepare(sql) { return new OpsStmt(this, sql); }
    seed(direction, opKey, extra = {}) {
        this.rows.set(`${direction}|${opKey}`, { status: 'pending', attempts: 0, fee_state: null, fee_attempts: 0, ...extra });
    }
}

export class OnboardD1 {
    constructor() { this.rows = new Map(); }
    prepare(sql) { return new OnboardStmt(this, sql); }
}
