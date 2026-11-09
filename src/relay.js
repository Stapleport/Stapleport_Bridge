// 双向中继主循环。
//
// 正向：源链 Vault.Deposit(seq) → stapleport StapleportBridge.executeMint（仅通道 authority 可调）
// 反向：stapleport StapleportBridge.BurnRequest(seq) → 源链 Vault.executeRelease（outId=seq，跨链唯一）
//
// 可靠性设计：
// - 游标存 D1（cursors 表），首轮只落基线不处理历史（照 SelfSweep monitor 口径）
// - ops 表 INSERT OR IGNORE 抢占 + 合约层幂等（minted/released）双保险：
//   D1 丢失最多多烧几笔被合约拦下的空交易，绝不双铸/双放
// - 广播后不强等回执：op 保持 pending，下一轮先用链上幂等位对账（minted/released）
//   命中即 done；未命中且 attempts 未超限则重发
//
// 签名钥：各函数入参 `wallet` = 单钥账户或分层钥对象 { base, hub, src, fee }（lib/tx.js
// resolveSigner 解析）。hub=78756 通道 authority 钥、src=spoke 侧 authority 钥、fee=hub
// dir2 领奖槽 feeClaimAuthority 钥；单钥部署（一钥兼全部）继续原样可用。
// ---- 装配层：实现按功能域拆至 ./relay/，本文件只做导出面（路径/名字/启动时机零变化）----
export { ZERO_ADDRESS, channelKeyOf, outKeyOf } from './relay/keys.js';
export { attemptClaim, ensureClaim } from './relay/claims.js';
export { isAdjudicatedSettled } from './relay/adjudication.js';
export { relayForward } from './relay/mint.js';
export { relayReverse } from './relay/release.js';
export { relayOutForward } from './relay/outMint.js';
export { relayOutReverse } from './relay/outRelease.js';
