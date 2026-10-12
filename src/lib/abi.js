// 桥交互所需的最小 ABI（viem human-readable）。registry.json 里存合约地址，这里存形状。
// 2026-10-11 去费版（bridge-defee）：费面/swap 族/押金闸全删，签名随收缩（topic0 更替；
// 全新部署零兼容负担）。契约唯一正典=bridge-defee-plan §3.2 函数签名集/§3.3 事件集；
// 改合约必须同步本文件（既有文件头纪律）。
import { parseAbi } from 'viem';

// 源链资金池（我方部署；authority = 本 worker 地址才调得动 executeRelease/refundDeposit）
export const vaultAbi = parseAbi([
    'event Deposit(uint256 indexed seq, uint256 chainIndex, address indexed token, address indexed depositor, address recipient, uint256 amount, uint256 buyDeadline)',
    // 过期落地指令事件（vault_in.executeRelease 过期分支发射，relayer 次轮拾取执行 refund_burn 腿）
    'event ReleaseSkipped(uint256 chainIndex, uint256 outId, address spToken, address recipient, uint256 amount, uint256 buyDeadline)',
    'function executeRelease(uint256 outId, address token, address to, uint256 amount, uint256 buyDeadline)',
    'function released(uint256 outId) view returns (bool)',
    'function deposits(uint256 seq) view returns (address token, address depositor, address recipient, uint256 amount, uint256 buyDeadline)',
    'function poolBalance(address token) view returns (uint256)',
    'function authority() view returns (address)',
    // 退款腿（dir1 入向存款过期；只需 seq，池内全额 token 付 depositor）+ 幂等视图
    'function refundDeposit(uint256 seq)',
    'function depositRefunded(uint256 seq) view returns (bool)',
    // E流 onboarding：chainIndex 后配（BridgeBatchDeployer 出厂为 0，authority/owner 一次性设非 0 后锁定）
    'function chainIndex() view returns (uint256)',
    'function setChainIndex(uint256 idx)',
    // ===== 用户预付 gas 费率面（bridge-fee-design §3.3 / §2；dir1 域 = BSC vault-in 实例）=====
    // 入口 payable 化（签名零变更、仅加 payable——selector 不变）；领奖/垫下限/Fees getter/配置腿。
    'function deposit(address token, uint256 amount, address recipient) payable returns (uint256)',
    'function padFloorDir1() view returns (uint256)',
    'function legBDir1() view returns (uint128)',
    'function depositFees(uint256 seq) view returns (uint128 pad, uint128 reward, address payer, uint8 state)',
    'function claimDepositFee(uint256 seq)',
    'function feeRecipient() view returns (address)',
    'function setLegB(uint8 dir, uint128 val)',
    'function setFeeRecipient(address r)',
]);

// Stapleport 桥（executeMint/executeOutRelease 仅通道 authority 可调；minted/outReleased
// 做链上幂等对账；outLocks/outStanding 做出向参数现读与在库预检）
// E流 onboarding 增补：getChannel/getOutChannel（存在性先读 + spToken 回填）。openChannel/
// openOutChannel 去费后转 MANAGE-only、开通道动作转人工，本 ABI 仅保留收缩签名备读。
// 链注册表宿主 = spBridge 门面（registry 读口直走 spBridge 地址 + registryAbi，见 config/onboarding）。
export const spBridgeAbi = parseAbi([
    'event BurnRequest(uint256 indexed seq, bytes32 indexed channelKey, address spToken, uint256 chainIndex, address indexed recipient, uint256 amount, uint256 buyDeadline)',
    'event LockOut(uint256 indexed seq, bytes32 indexed outKey, uint256 chainIndex, address indexed recipient, uint256 amount, uint256 buyDeadline)',
    // 过期落地指令事件（hub 侧）：dir1 mint 过期 → DepositRefunded；dir4 outrelease 过期 → OutReleaseSkipped
    'event DepositRefunded(uint256 chainIndex, uint256 seq)',
    'event OutReleaseSkipped(uint256 chainIndex, uint256 outBurnId, address token, address recipient, uint256 amount, uint256 buyDeadline)',
    'function executeMint(uint256 chainIndex, uint256 depositSeq, address spToken, address to, uint256 amount, uint256 buyDeadline)',
    'function executeOutRelease(uint256 chainIndex, uint256 outBurnId, address to, uint256 amount, uint256 buyDeadline)',
    // ERC20 出向 mod（bridge_out_erc20.sol）：回程赎回释放按 token 计；幂等视图按 outKeyE20
    'function executeOutReleaseERC20(uint256 chainIndex, address token, uint256 outBurnId, address to, uint256 amount, uint256 buyDeadline)',
    // 退款腿（dir2 burn 过期 → hub 重铸毛额 spToken 给原请求人；dir3 outlock 过期 → 回付 locker 全额）
    // direction 隔离即 native/erc20 撞号免疫：ERC20 出向走独立 executeOutRefundERC20/outLockErc20Refunded
    'function executeBurnRefund(uint256 chainIndex, address spToken, uint256 burnSeq, address to, uint256 amount)',
    'function executeOutRefund(uint256 seq)',
    'function executeOutRefundERC20(uint256 seq)',
    'function minted(bytes32 channelKey, uint256 depositSeq) view returns (bool)',
    'function outReleased(uint256 chainIndex, uint256 outBurnId) view returns (bool)',
    'function outReleasedErc20(bytes32 outKey, uint256 outBurnId) view returns (bool)',
    'function outLocks(uint256 seq) view returns (uint256 chainIndex, address recipient, uint256 amount, address locker, uint256 buyDeadline)',
    'function outLocksErc20(uint256 seq) view returns (uint256 chainIndex, address token, address recipient, uint256 amount, address locker, uint256 buyDeadline)',
    'function outStanding(bytes32 outKey) view returns (uint256)',
    'function outStandingErc20(bytes32 outKey) view returns (uint256)',
    // 退款幂等视图（合约旗标拦重放；refund op 发送前/收尾对账用）
    'function burnRefunded(uint256 burnSeq) view returns (bool)',
    'function outLockRefunded(uint256 seq) view returns (bool)',
    'function outLockErc20Refunded(uint256 seq) view returns (bool)',
    'function openChannel((uint256 chainIndex, address srcToken, address authority, string name, string symbol) p) returns (bytes32 channelKey)',
    'function openOutChannel((uint256 chainIndex, address authority) p) returns (bytes32 outKey)',
    'function getChannel(bytes32 channelKey) view returns ((uint256 chainIndex, address srcToken, address spToken, address authority, bool active))',
    'function getOutChannel(bytes32 outKey) view returns ((uint256 chainIndex, address authority, bool active))',
    // ===== 用户预付 gas 费率面（bridge-fee-design §3.3 / §2；hub 域 = dir2/dir3 费 escrow 落链）=====
    // 入口 payable 化（五入口签名零变更、仅加 payable）；dir2/dir3 垫下限/Fees getter 在 hub。
    'function requestBurn(address spToken, uint256 chainIndex, address recipient, uint256 amount) payable',
    'function lockOut(uint256 chainIndex, address recipient, uint256 amount) payable returns (uint256)',
    'function lockOutERC20(uint256 chainIndex, address token, address recipient, uint256 amount) payable returns (uint256)',
    'function padFloorDir2() view returns (uint256)',
    'function padFloorDir3() view returns (uint256)',
    'function legBDir2() view returns (uint128)',
    'function legBDir3() view returns (uint128)',
    'function burnFees(uint256 seq) view returns (uint128 pad, uint128 reward, address payer, uint8 state)',
    'function outLockFees(uint256 seq) view returns (uint128 pad, uint128 reward, address payer, uint8 state)',
    'function outLockFeesErc20(uint256 seq) view returns (uint128 pad, uint128 reward, address payer, uint8 state)',
    'function claimBurnFee(uint256 burnSeq)',
    'function claimOutLockFee(uint256 seq)',
    'function claimOutLockFeeErc20(uint256 seq)',
    'function feeRecipient() view returns (address)',
    'function setLegB(uint8 dir, uint128 val)',
    'function setFeeRecipient(address r)',
    'function setFeeClaimAuthority(address a)',
]);

// hub ChainRegistry（E流 onboarding/派生层）：注册无许可、rpc 规范化=转小写+去尾/
// （规范化在同侧 JS 镜像实现于 onboarding.js normalizeRpc）。宿主地址 = spBridge 门面。
export const registryAbi = parseAbi([
    'function registerChain(uint64 evmChainId, string rpc) returns (uint256 idx)',
    'function lookupByChainId(uint64 evmChainId) view returns (uint256[])',
    'function resolve(uint256 idx) view returns (uint256 finalIdx, (uint64 evmChainId, string rpc, uint256 mergedInto, bool active) chain)',
    'function chains(uint256 idx) view returns ((uint64 evmChainId, string rpc, uint256 mergedInto, bool active))',
    'function nextIndex() view returns (uint256)',
]);

// 外链出向金库（executeOutMint 仅通道 authority 可调；outMinted 做链上幂等对账）
export const outVaultAbi = parseAbi([
    'event BurnOut(uint256 indexed outBurnId, address indexed recipient, uint256 amount, uint256 buyDeadline)',
    // 过期落地指令事件（dir3 outmint 过期；vault_out.executeOutMint 过期分支发射）
    'event OutMintRefunded(uint256 chainIndex, uint256 inId)',
    // 尾参 bool erc20：两族幂等键空间分流（native=outMinted、erc20=outMintedErc20）。hub 双计数器
    // outSeq/outSeqErc20 各自从 1 起、数值可重叠，同出向金库实例（web 出向共用单一 out.vault/spN）
    // 必须分族，否则一族先落地会把另一族同 inId 误判成已落地。
    'function executeOutMint(uint256 inId, address to, uint256 amount, uint256 buyDeadline, bool erc20)',
    'function outMinted(uint256 inId) view returns (bool)',
    'function outMintedErc20(uint256 inId) view returns (bool)',
    'function outBurns(uint256 outBurnId) view returns (address recipient, uint256 amount, uint256 buyDeadline)',
    // 退款腿（dir4 outburn 过期 → 重铸毛额给 recipient）+ 幂等视图
    'function executeOutBurnRefund(uint256 outBurnId)',
    'function outBurnRefunded(uint256 outBurnId) view returns (bool)',
    'function spN() view returns (address)',
    // E流 onboarding：chainIndex 后配（同 BridgeVault，0→chainIndex 一次性）
    'function chainIndex() view returns (uint256)',
    'function setChainIndex(uint256 idx)',
    // ===== 用户预付 gas 费率面（bridge-fee-design §3.3 / §2；dir4 域 = BSC vault-out 实例）=====
    'function requestOutBurn(address recipient, uint256 amount) payable returns (uint256)',
    'function padFloorDir4() view returns (uint256)',
    'function legBDir4() view returns (uint128)',
    'function outBurnFees(uint256 outBurnId) view returns (uint128 pad, uint128 reward, address payer, uint8 state)',
    'function claimOutBurnFee(uint256 outBurnId)',
    'function feeRecipient() view returns (address)',
    'function setLegB(uint8 dir, uint128 val)',
    'function setFeeRecipient(address r)',
]);

export const erc20Abi = parseAbi([
    'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)',
]);

// 事件签名哈希（与合约事件逐字段对齐，改合约必须同步这里）
// 2026-10-11 去费版：Deposit/LockOut/BurnOut 删 swapTo·minOut/fee 尾参 ⇒ 串变、topic0 随之更替；
// BurnRequest 无费字段不变。4 过期落地指令事件签名不变。
export const DEPOSIT_EVENT = 'Deposit(uint256,uint256,address,address,address,uint256,uint256)';
export const BURN_EVENT = 'BurnRequest(uint256,bytes32,address,uint256,address,uint256,uint256)';
export const LOCKOUT_EVENT = 'LockOut(uint256,bytes32,uint256,address,uint256,uint256)';
export const BURNOUT_EVENT = 'BurnOut(uint256,address,uint256,uint256)';
// 4 过期落地指令事件 topic（refund.js 扫链用）
export const DEPOSIT_REFUNDED_EVENT = 'DepositRefunded(uint256,uint256)';
export const RELEASE_SKIPPED_EVENT = 'ReleaseSkipped(uint256,uint256,address,address,uint256,uint256)';
export const OUT_MINT_REFUNDED_EVENT = 'OutMintRefunded(uint256,uint256)';
export const OUT_RELEASE_SKIPPED_EVENT = 'OutReleaseSkipped(uint256,uint256,address,address,uint256,uint256)';

// ===== 通用指令信封 InstructionOutbox（v2 设计稿 §1.1；2026-10-12 T1 追加）=====
// 与 T0 已落合约 Stapleport_Bridge_hardhat/contracts/envelope/InstructionOutbox.sol 逐字段对齐
// （事件 topic0 逐字冻结；targetRegistry 三返回 getter；instructions getter 尾参 state 终态机）。
// relayer 只消费：Instruction/Refunded 事件（扫链）+ refund/claim（源链动作）+ targetRegistry（对拍读口）。
export const instructionOutboxAbi = parseAbi([
    'event Instruction(uint256 seq, bytes32 indexed targetId, bytes data, uint256 value, uint256 fee, uint64 deadline, bytes priceSnapshot, bytes refundSpec, address payer)',
    'event Refunded(uint256 seq, bytes refundSpec, bool ok)',
    'event TargetRegistered(bytes32 targetId, uint64 dstChainIndex, address addr)',
    'function send((bytes32 targetId, bytes data, uint256 value, uint64 deadline, bytes priceSnapshot, bytes refundSpec, address payer) s) payable returns (uint256 seq)',
    'function claim(uint256 seq)',
    'function refund(uint256 seq)',
    'function registerTarget(bytes32 targetId, uint64 dstChainIndex, address addr)',
    'function registerLocalRefund(address a)',
    'function setLegB(uint256 v)',
    'function setPaused(bool p)',
    // 对拍读口（§3.1 启动对拍）+ 终态对账读口（instructions.state：0 Pending/1 Claimed/2 Refunded）
    'function targetRegistry(bytes32 targetId) view returns (uint64 dstChainIndex, address addr, bool registered)',
    'function instructions(uint256 seq) view returns (bytes32 targetId, bytes data, uint256 value, uint256 fee, uint128 pad, uint64 deadline, bytes priceSnapshot, bytes refundSpec, address payer, uint8 state)',
    'function seq() view returns (uint256)',
    'function authority() view returns (address)',
]);
export const INSTRUCTION_EVENT = 'Instruction(uint256,bytes32,bytes,uint256,uint256,uint64,bytes,bytes,address)';
export const REFUNDED_EVENT = 'Refunded(uint256,bytes,bool)';
