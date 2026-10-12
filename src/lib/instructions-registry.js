// 通用指令信封 registry 静态配置件（v2 设计稿 §2/§3.1）：targetId→{srcChain,dstChain,addr,slots[]}
// + 需扫描的源链 outbox 清单 + 涉及链 rpc。operator 维护；不并入既有 CHANNELS/OUT_CHANNELS
// 装载面（新增独立文件+独立 loader，零改 config.js）。env.INSTRUCTION_REGISTRY（JSON 串）
// 可整体覆盖文件值（测试/本地彩排用）。启动对拍拒启见 src/instructions.js verifyRegistry。
import fileReg from '../instructions.registry.json' with { type: 'json' };

function normTarget(id, t) {
    return {
        srcChain: t.srcChain != null ? String(t.srcChain) : null,
        dstChain: String(t.dstChain),
        addr: String(t.addr).toLowerCase(),
        slots: Array.isArray(t.slots)
            ? t.slots.map((s) => ({ offset: Number(s.offset), kind: String(s.kind) }))
            : [],
    };
}

// 规范化（targetId/addr 小写、chain 键文本化）——纯函数，供单测。
export function parseInstructionRegistry(raw) {
    const targets = {};
    for (const [id, t] of Object.entries(raw?.targets ?? {})) targets[String(id).toLowerCase()] = normTarget(id, t);
    const outboxes = (raw?.outboxes ?? []).map((o) => ({
        chainIndex: String(o.chainIndex),
        addr: String(o.addr).toLowerCase(),
    }));
    const chains = {};
    for (const [idx, c] of Object.entries(raw?.chains ?? {})) {
        chains[String(idx)] = {
            rpcUrl: c?.rpcUrl ? String(c.rpcUrl) : null,
            confirmations: Number(c?.confirmations ?? 3),
        };
    }
    return { chains, outboxes, targets };
}

// 装载：文件为底，env.INSTRUCTION_REGISTRY 覆盖（浅合并，键整体替换）。
export function loadInstructionRegistry(env) {
    let raw = fileReg;
    let source = 'file';
    const override = String(env?.INSTRUCTION_REGISTRY ?? '').trim();
    if (override) {
        raw = { ...fileReg, ...JSON.parse(override) };
        source = 'env';
    }
    const reg = parseInstructionRegistry(raw);
    reg.source = source;
    return reg;
}
