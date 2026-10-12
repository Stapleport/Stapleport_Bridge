-- 桥用户预付 gas 费率面 · D1 schema 扩展（设计稿 bridge-fee-design §3.1，D1/D4）。
-- status 枚举不动（仍 pending|done，重试扫描零回归）；费率分类走新列：
--   fee_state    text       null=未评估 | 'admit' 达标已广播 | 'insufficient' 不足未广播
--                           | 'never_sweep' 垃圾终态（paid < 重估裁决两腿成本，永不裁决/不退款）
--                           | 'refund_stuck' / 'claim_stuck' 卡死终态（退款腿/领奖腿预估连续失败
--                             ≥stuckThreshold，停试不再扫；链上语义：B 侧已裁决终态、A 侧本金+费
--                             滞留 escrow，无资金风险，恶意 payer 自担——追派二）
--   fee_attempts integer    准入尝试计次（≤5，D4；与 attempts 独立——attempts 记广播失败重试）；
--                           退款/领奖腿行借本列作「预估连续失败」卡死计数器（独立于 MAX_ATTEMPTS）
alter table ops add column fee_state text;
alter table ops add column fee_attempts integer not null default 0;
