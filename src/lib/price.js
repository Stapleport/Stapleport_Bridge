// 通用指令信封价格 fetcher（v2 设计稿 §3.3 kind→fetcher 映射）。本仓只存 kind 映射与
// BNB 参考价实现——新增 kind（新价格源种类）才需在此加一行；复用既有 kind worker 零改。
//
// 维度口径（R7）：bnbRefPrice18 = USDT/BNB（每 BNB 值多少 USDT，≈754），1e18 定标；
// 消费侧闸门一律除法 quoteU18*1e18/bnbRefPrice18（勿乘，乘会放大约 754 倍致闸门恒过）。
//
// 取源：BRIDGE_PRICE_BNB_OVERRIDE 优先（e2e 零外网）；否则 HTTP ${oracleBase}/price?token=BNB，
// status!=='ok' 或取不到 → null（调用方本轮 skip，留 last_error）。5s TTL cache（照 oracle price.js 口径）。
const TTL_MS = 5000;
let cache = { key: null, at: 0, value: null };

// "754.77" → 754770000000000000000n（≤18 位小数无损升位；整数部分可大）。纯函数，供单测。
export function scaleTo18(v) {
    const s = String(v).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`bad price: ${s}`);
    const [int, fracRaw = ''] = s.split('.');
    const frac = (fracRaw + '0'.repeat(18)).slice(0, 18);
    return BigInt(int) * 10n ** 18n + BigInt(frac);
}

export async function fetchBnbRefPrice18(env, cfg) {
    const override = String(env?.BRIDGE_PRICE_BNB_OVERRIDE ?? '').trim();
    if (override) return scaleTo18(override);
    if (!cfg?.oracleBase) return null;
    const key = `bnb:${cfg.oracleBase}`;
    const now = Date.now();
    if (cache.key === key && now - cache.at < TTL_MS) return cache.value;
    let value = null;
    try {
        const res = await fetch(`${cfg.oracleBase}/price?token=BNB`, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
            const json = await res.json();
            if (json && json.status === 'ok' && json.price != null) value = scaleTo18(json.price);
        }
    } catch (e) {
        console.log(`[bridge] 价格口读取失败 token=BNB：${String(e.message).slice(0, 120)}`);
    }
    cache = { key, at: now, value };
    return value;
}

// kind → fetcher（新增 kind 才加一行）。未知 kind 抛错（配置错误显式暴露，不静默）。
export const PRICE_FETCHERS = {
    bnbRefPrice18: fetchBnbRefPrice18,
};

export async function fetchPrice18(env, cfg, kind) {
    const fn = PRICE_FETCHERS[kind];
    if (!fn) throw new Error(`unknown price kind: ${kind}`);
    return fn(env, cfg);
}
