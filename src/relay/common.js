// 跨方向共享小工具：ctx.waitUntil 可选拆包、估 gas 连败计次（F-018b）。
import { setFeeState, bumpStuckCount } from '../lib/store.js';
import { notify } from '../notify.js';

// 估 gas 连败计次（F-018b；借 fee_attempts 列，独立于 ops.attempts）：连败 ≥ stuckThreshold 写卡死
// 终态 fee_state='<direction>_stuck' + 告警一次，重试循环按该终态跳过本行（口径同 refund/claim 先例）。
export async function noteEstimateFail(env, cfg, db, { direction, key, chainIndex, seq }) {
    const n = await bumpStuckCount(db, direction, key);
    if (n >= (cfg.stuckThreshold ?? 5)) {
        await setFeeState(db, direction, key, `${direction}_stuck`);
        await notify(env, { event: `${direction}_stuck`, channel: chainIndex, seq, note: 'estimate-fail >= threshold, terminal stop' });
    }
}

// ctx.waitUntil 的可选拆包（单测里没有 ctx）
export function ctxWait(env, promise) {
    return promise;
}
