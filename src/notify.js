// 事件告警：webhook POST JSON。2026-09-17 起走 kit notifyWebhook（bigint 安全序列化收编），
// 并补齐 AbortSignal.timeout(8000) 护栏——原版无 timeout，节点卡死会把 tick 吊住。
// 本仓保留「先整包 console.log」的口径：bridge 日志即事件流水，第三方自托管者靠它排障。
import { notifyWebhook } from '@stapleport/worker-kit';

const stringify = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

export async function notify(env, payload) {
    const at = new Date().toISOString();
    console.log(`[bridge] ${stringify({ source: 'stapleport-bridge', at, ...payload })}`);
    await notifyWebhook({
        url: env.WEBHOOK_URL,
        source: 'stapleport-bridge',
        payload,
        at,
        timeoutMs: 8000,
        log: (m) => console.log(`[bridge] ${m}`),
    });
}
