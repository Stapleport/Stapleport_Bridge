// JSON-RPC 薄封装（照 SelfSweep 口径：裸 fetch，不引重型客户端）。
// 2026-09-17 起收编 @stapleport/worker-kit：id 统一 1（原 Date.now()）、错误串统一
// 带 JSON.stringify 兜底；kit 只做读写通道，本仓签名面留在 lib/tx.js（wallet 才碰私钥）。
// 原 topicAddr 死导出（零消费）随之删除。
export { rpc, hexToBigInt, toHex, latestBlock, callRaw } from '@stapleport/worker-kit';
