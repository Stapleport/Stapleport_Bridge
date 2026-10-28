// JSON-RPC 薄封装（照 SelfSweep 口径：裸 fetch，不引重型客户端）。
// 2026-09-17 起收编 @stapleport/worker-kit；kit 只做读写通道，本仓签名面留在 lib/tx.js。
// 2026-10-11 RPC 备援（RPC 单点缓解）：config.js srcChainsRpcs → registerRpcGroup 注册多条，
// 多条时按失败轮换（failover；全败抛最后错误，不吞错、不改错误类型）。
// 2026-10-17 failover 实体下沉 kit（registerRpcGroup + 轮换通道），本文件退化为纯壳：只再导出。
// 接口形状零变（rpc/latestBlock/callRaw/nativeBalance/hexToBigInt/toHex/registerRpcGroup 七件同前）。
export { rpc, latestBlock, callRaw, nativeBalance, hexToBigInt, toHex, registerRpcGroup } from '@stapleport/worker-kit';
