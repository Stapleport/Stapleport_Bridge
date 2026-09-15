# Stapleport_Bridge — 跨链桥 relayer 客户端

零公网面的桥执行客户端（Cloudflare Worker，纯 cron 驱动）。任何人自托管这份代码、
换上自己的私钥，就成为一名 relayer（通道 authority），为通道执行 mint/release 赚小费。

## 角色与信任模型（先读这个）

- **桥方（我方）**：拥有 stapleport 端点合约（ZMBridge/StakePool/ChainRegistry/映射币工厂），
  并以专用部署账号部署每条接入链的 BridgeVault（部署权=字节码保证+admin 控制权）。
  收入 = 全部通道的协议费。
- **接入方（第三方链）**：打 gas 到桥方部署账号 → 桥方部署 Vault → 在 stapleport 质押作通道担保 →
  自托管本 Worker（自己的 key = 通道 authority）→ 自营赚小费。
- **信任锚 = stapleport 侧押金**：rpc 可造假，但 mint 必须押金且受覆盖系数约束（流通估值 ≤
  通道押金估值 × coverageBps，超额合约 revert）；作恶被 3× 份额裁判判罚，罚没进
  该通道隔离的保险池——一个桥暴雷只烧它自己的池子，不传染别的通道。
- **50% 额度规则**：通道短时间最大可执行量 = 押金估值/2 − 在途（滴灌回收）+ 窗口绝对上限。
  作恶收益上限 < 被充公下限，理性 relayer 不作恶。
- **威胁模型口径**：锁依赖（仅 viem）+ 官方 RPC + 密钥只进 wrangler secret；本机/CF 账号
  级失陷属于物理层失效，靠最小权限 key（authority 无任何 admin 权）+ 轮换
  （setChannelAuthority 换地址旧 key 即废）+ 押金封顶兜底。

## 双向流程

```
正向：源链 Vault.deposit ──Deposit(seq)──▶ Worker ──▶ stapleport ZMBridge.executeMint（扣 0.1%）
反向：stapleport ZMBridge.requestBurn（真烧）──BurnRequest(seq)──▶ Worker ──▶ 源链 Vault.executeRelease（扣 0.1%）
```

- outId = stapleport burnSeq（全局唯一）→ Vault 层幂等；depositSeq 幂等在 ZMBridge 层；
  两层合约幂等 + 本 Worker D1 ops 表 = 双保险，D1 丢失最多烧几笔被合约拦下的空交易。
- 精度换算：源币 → 18 位映射币无损放大；18 → 源币 floor，尾差留池（池只多不少）。
- harvest：源链 Vault 攒的手续费经 swap 换 native（tip 给执行者回血 + 协议费），
  「第三方链手续费折 gas 必须覆盖中继成本」由此兑现。

## 部署（接入方自助清单）

1. 合约侧（桥方操作，见 Stapleport_hardhat/scripts/Bridge/deploy.js）：
   - hub（stapleport）：`BRIDGE_ROLE=hub pnpm hardhat run scripts/Bridge/deploy.js --network stapleport`
   - 源链：`BRIDGE_ROLE=source BRIDGE_CHAIN_INDEX=<索引> BRIDGE_AUTHORITY=<你的地址>
     pnpm hardhat run scripts/Bridge/deploy.js --network <接入链>`
2. stapleport 上：`registry.registerChain(chainId, rpc)` → `zmBridge.openChannel({chainIndex,
   srcToken, authority=你的地址, gasPolicy, freeQuota=100, protocolBps/tipBps/thickBps,
   coverageBps, refPriceNative, name, symbol})`
3. 质押：`stakePool.stakeNative{value}()` → `stakePool.bind(channelKey, shares, 0)`
   ——押金决定发行上限与额度，轮换 authority 不带走押金。
4. 本 Worker：
   ```bash
   wrangler d1 create stapleport-bridge-db   # id 填进 wrangler.jsonc
   wrangler d1 migrations apply stapleport-bridge-db --local   # 远端去掉 --local
   node scripts/sync-registry.mjs            # 从合约仓同步地址
   wrangler secret put BRIDGE_RELAYER_PRIVATE_KEY
   # wrangler.jsonc 里配 CHANNELS / SRC_CHAINS / HUB_CHAIN_ID
   wrangler deploy
   ```
5. 链身份查询：ChainRegistry 有 `lookupByChainId(chainId)` / `chains(index)` /
   `resolve(index)`；CLI 查询可用：
   `pnpm hardhat run scripts/Bridge/deploy.js` 无关——直接 `cast call` 或写两行 ethers。
   唯一键 = (chainId, 规范化 rpc)，同 chainId 不同 rpc 是不同链索引；rpc 变更由桥方
   `setChainRpc`/`mergeChain` 合并。

## CHANNELS / SRC_CHAINS 配置样例

```jsonc
// vars.CHANNELS —— 本 key 作为 authority 的通道
[{ "chainIndex": "1", "srcToken": "0x55d...", "zmToken": "0xabc...",
   "srcDecimals": 18, "vault": "0xdef...", "covered": true }]
// vars.SRC_CHAINS —— 源链 rpc 与确认数（野链确认数按尽调定）
{ "1": { "rpc": "https://rpc.opchain.example", "confirmations": 15 } }
// vars.HUB_CHAIN_ID / RPC_URL_HUB / ZMBRIDGE —— stapleport 端
```

`covered: true` 的通道（第三方链）执行前做 gas 覆盖预检：relayer 余额 ≥
预估 gas×价×GAS_MARGIN_X10/10 才发交易，否则挂起告警。

## 本地 E2E

```bash
cd Stapleport_hardhat
./node_modules/.bin/hardhat node --port 8546   # 或复用共享 dev 节点(8545)
./node_modules/.bin/hardhat run scripts/Bridge/e2e.js --network localhost
# 期望输出：=== E2E 全环 PASS：锁仓 → mint → 烧 → release → harvest ===
```

E2E 直接驱动本仓 src 真实代码（D1 用内存 shim），验证：锁仓 100 USDT(6位) →
mint 99.7 zmUSDT(18位) → burn 40 → release 39.96 → harvest 换 native 分账。

## Worker 结构

```
src/worker.js    入口：cron tick（isolate 锁）+ GET /health
src/config.js    配置装载（vars + registry.json + env 覆盖）与精度换算
src/relay.js     正向/反向中继：游标 getLogs → ops 抢占 → 链上幂等对账 → 签名广播 → 重试
src/harvest.js   手续费换 gas 回血
src/notify.js    webhook 告警（mint_stuck / pool_insufficient / gas_coverage_low / harvest…）
src/lib/*        JSON-RPC 封装 / 最小 ABI / D1 store / 签名广播（legacy gasPrice 兜底）
migrations/      D1：cursors（区块游标）+ ops（幂等/重试）
```
