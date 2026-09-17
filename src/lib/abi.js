// 桥交互所需的最小 ABI（viem human-readable）。registry.json 里存合约地址，这里存形状。
import { parseAbi } from 'viem';

// 源链资金池（我方部署；authority = 本 worker 地址才调得动 executeRelease/harvest）
export const vaultAbi = parseAbi([
    'event Deposit(uint256 indexed seq, uint256 chainIndex, address indexed token, address indexed depositor, address recipient, uint256 amount, address swapTo, uint256 minOut)',
    'function executeRelease(uint256 outId, address token, address to, uint256 amount)',
    'function released(uint256 outId) view returns (bool)',
    'function deposits(uint256 seq) view returns (address token, address depositor, address recipient, uint256 amount, address swapTo, uint256 minOut)',
    'function poolBalance(address token) view returns (uint256)',
    'function pendingFee(address token) view returns (uint256)',
    'function minFee(address token) view returns (uint256)',
    'function feeBps() view returns (uint16)',
    'function authority() view returns (address)',
    'function harvest(address token, uint256 amountOutMin)',
    'function swapFactory() view returns (address)',
    'function wnative() view returns (address)',
    // E流 onboarding：chainIndex 后配（BridgeBatchDeployer 出厂为 0，authority/owner 一次性设非 0 后锁定）
    'function chainIndex() view returns (uint256)',
    'function setChainIndex(uint256 idx)',
]);

// Stapleport 桥（executeMint/executeMintSwap 仅通道 authority 可调；minted/outReleased
// 做链上幂等对账；outLocks/outStanding 做出向参数现读与在库预检）
// E流 onboarding 增补：openChannel/openOutChannel（无许可开通道，重复开 revert
// "channel exists"/"out channel exists"）、getChannel/getOutChannel（存在性先读 + stplToken 回填）、
// registry()（派生层定位 ChainRegistry）
export const stplBridgeAbi = parseAbi([
    'event BurnRequest(uint256 indexed seq, bytes32 indexed channelKey, address stplToken, uint256 chainIndex, address indexed recipient, uint256 amount)',
    'event LockOut(uint256 indexed seq, bytes32 indexed outKey, uint256 chainIndex, address indexed recipient, uint256 amount, address swapTo, uint256 minOut)',
    'function executeMint(uint256 chainIndex, uint256 depositSeq, address stplToken, address to, uint256 amount)',
    'function executeMintSwap(uint256 chainIndex, uint256 depositSeq, address stplIn, address stplOut, address to, uint256 amount, uint256 minOut)',
    'function executeOutRelease(uint256 chainIndex, uint256 outBurnId, address to, uint256 amount)',
    'function minted(bytes32 channelKey, uint256 depositSeq) view returns (bool)',
    'function outReleased(uint256 chainIndex, uint256 outBurnId) view returns (bool)',
    'function outLocks(uint256 seq) view returns (uint256 chainIndex, address recipient, uint256 amount, address swapTo, uint256 minOut)',
    'function outStanding(bytes32 outKey) view returns (uint256)',
    'function openChannel((uint256 chainIndex, address srcToken, address authority, uint8 gasPolicy, uint32 freeQuota, uint16 protocolBps, uint16 tipBps, uint16 thickBps, uint16 coverageBps, uint96 refPriceNative, string name, string symbol) p) returns (bytes32 channelKey)',
    'function openOutChannel((uint256 chainIndex, address authority, uint16 protocolBps, uint16 tipBps, uint16 releaseBps, uint16 coverageBps) p) returns (bytes32 outKey)',
    'function getChannel(bytes32 channelKey) view returns ((uint256 chainIndex, address srcToken, address stplToken, address authority, uint8 gasPolicy, uint32 freeQuota, uint32 relays, uint16 protocolBps, uint16 tipBps, uint16 thickBps, uint16 coverageBps, uint96 refPriceNative, bool active))',
    'function getOutChannel(bytes32 outKey) view returns ((uint256 chainIndex, address authority, uint16 protocolBps, uint16 tipBps, uint16 releaseBps, uint16 coverageBps, bool active))',
    'function registry() view returns (address)',
]);

// hub ChainRegistry（E流 onboarding/派生层）：注册无许可、rpc 规范化=转小写+去尾/
// （规范化在同侧 JS 镜像实现于 onboarding.js normalizeRpc）
export const registryAbi = parseAbi([
    'function registerChain(uint64 evmChainId, string rpc) returns (uint256 idx)',
    'function lookupByChainId(uint64 evmChainId) view returns (uint256[])',
    'function resolve(uint256 idx) view returns (uint256 finalIdx, (uint64 evmChainId, string rpc, uint256 mergedInto, bool active) chain)',
    'function chains(uint256 idx) view returns ((uint64 evmChainId, string rpc, uint256 mergedInto, bool active))',
    'function nextIndex() view returns (uint256)',
]);

// 外链出向金库（executeOutMint(Swap) 仅通道 authority 可调；outMinted 做链上幂等对账）
export const outVaultAbi = parseAbi([
    'event BurnOut(uint256 indexed outBurnId, address indexed recipient, uint256 amount, uint256 fee)',
    'function executeOutMint(uint256 inId, address to, uint256 amount)',
    'function executeOutMintSwap(uint256 inId, address to, uint256 amount, uint256 minOut, address swapTo)',
    'function outMinted(uint256 inId) view returns (bool)',
    'function outBurns(uint256 outBurnId) view returns (address recipient, uint256 amount)',
    'function pendingFee(address token) view returns (uint256)',
    'function stplN() view returns (address)',
    'function wnative() view returns (address)',
    'function swapFactory() view returns (address)',
    'function harvest(address token, uint256 amountOutMin)',
    'function harvestViaRouter(address router, address[] path, uint256 amountOutMin)',
    // E流 onboarding：chainIndex 后配（同 BridgeVault，0→chainIndex 一次性）
    'function chainIndex() view returns (uint256)',
    'function setChainIndex(uint256 idx)',
]);

// 质押池只读门（额度/覆盖预检；不达标时 worker 挂起告警而不是白烧 gas）
export const stakePoolAbi = parseAbi([
    'function availableOf(bytes32 channelKey) view returns (uint256)',
    'function boundValueOf(bytes32 channelKey) view returns (uint256)',
]);

export const erc20Abi = parseAbi([
    'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)',
]);

// SwapV2 池（harvest 报价与 stplX 计价）
export const pairAbi = parseAbi([
    'function getReserves() view returns (uint112, uint112, uint32)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
]);
export const factoryAbi = parseAbi([
    'function getPair(address, address) view returns (address)',
]);

// 第三方 V2 系 router（OutVault harvestViaRouter 的报价）
export const routerAbi = parseAbi([
    'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
]);

// 事件签名哈希（与合约事件逐字段对齐，改合约必须同步这里）
export const DEPOSIT_EVENT = 'Deposit(uint256,uint256,address,address,address,uint256,address,uint256)';
export const BURN_EVENT = 'BurnRequest(uint256,bytes32,address,uint256,address,uint256)';
export const LOCKOUT_EVENT = 'LockOut(uint256,bytes32,uint256,address,uint256,address,uint256)';
export const BURNOUT_EVENT = 'BurnOut(uint256,address,uint256,uint256)';
