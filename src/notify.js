// 事件告警：webhook POST JSON（照 SelfSweep notify 口径）。没配 URL 就只打日志。
// BigInt 安全序列化（事件参数里 uint256 一律 bigint，直接 stringify 会炸）
const stringify = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

export async function notify(env, payload) {
    const body = { source: 'stapleport-bridge', at: new Date().toISOString(), ...payload };
    console.log(`[bridge] ${stringify(body)}`);
    const url = env.WEBHOOK_URL;
    if (!url) return;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: stringify(body),
        });
    } catch (e) {
        console.log(`[bridge] webhook 失败：${e.message}`);
    }
}
