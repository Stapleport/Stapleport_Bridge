-- E流 自动 onboarding 状态机表（API /v1/chains?project=bridge → 链上注册/后配/开通道）
-- status = 当前该执行的动作（active 为终态）：
--   registered     查/注 hub ChainRegistry（lookupByChainId 复用或 registerChain）
--   indexed        spoke BridgeVault/OutVault setChainIndex 后配（0→chainIndex 一次性）
--   channeled      hub openChannel(入向 native) + openOutChannel(出向)
--   awaiting_stake 押金人工门：StakePool.boundValueOf 达标才放行（绝不自动质押）
--   active         终态：链拓扑由 config.js 派生层并入运行时 CHANNELS/OUT_CHANNELS
create table if not exists onboard (
    chain_id    integer not null,                   -- EVM chainId（API 行键；与 chainIndex 是两个维度）
    status      text not null default 'registered', -- 见上方状态机注释
    chain_index text,                               -- hub ChainRegistry 颁发索引（registered 步回填；文本存防大数）
    detail      text,                               -- JSON 档案：rpc/name/vault/outVault/outToken/stplToken/srcDecimals/covered
    updated_at  integer not null,
    primary key (chain_id)
);
