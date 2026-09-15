-- 桥 relayer 状态表（D1）
create table if not exists cursors (
    chain_id   text not null,          -- 'src:<chainIndex>' | 'hub'
    name       text not null,          -- 'deposit:<srcToken小写>' | 'burn'
    last_block integer not null default 0,
    updated_at integer not null,
    primary key (chain_id, name)
);

create table if not exists ops (
    direction  text not null,          -- 'mint'（正向 Deposit→executeMint）| 'release'（反向 Burn→executeRelease）
    op_key     text not null,          -- mint: '<chainIndex>:<seq>'；release: '<seq>'
    status     text not null default 'pending', -- pending | done
    attempts   integer not null default 0,
    tx_hash    text,
    last_error text,
    payload    text,                   -- release 重试参数存档（mint 从链上 deposits(seq) 现读，无需存）
    created_at integer not null,
    updated_at integer not null,
    primary key (direction, op_key)
);
