// 桥交互所需的最小 ABI（viem human-readable）。registry.json 里存合约地址，这里存形状。
import { parseAbi } from 'viem';

// 源链资金池（我方部署；authority = 本 worker 地址才调得动 executeRelease/harvest）
export const vaultAbi = parseAbi([
    'event Deposit(uint256 indexed seq, uint256 chainIndex, address indexed token, address indexed depositor, address recipient, uint256 amount)',
    'function executeRelease(uint256 outId, address token, address to, uint256 amount)',
    'function released(uint256 outId) view returns (bool)',
    'function poolBalance(address token) view returns (uint256)',
    'function pendingFee(address token) view returns (uint256)',
    'function minFee(address token) view returns (uint256)',
    'function feeBps() view returns (uint16)',
    'function authority() view returns (address)',
    'function harvest(address token, uint256 amountOutMin)',
    'function swapFactory() view returns (address)',
    'function wnative() view returns (address)',
]);

// Stapleport 桥（executeMint 仅通道 authority 可调；minted 做链上幂等对账）
export const zmBridgeAbi = parseAbi([
    'event BurnRequest(uint256 indexed seq, bytes32 indexed channelKey, address zmToken, uint256 chainIndex, address indexed recipient, uint256 amount)',
    'function executeMint(uint256 chainIndex, uint256 depositSeq, address zmToken, address to, uint256 amount)',
    'function minted(bytes32 channelKey, uint256 depositSeq) view returns (bool)',
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

// SwapV2 池（harvest 报价与 zmX 计价）
export const pairAbi = parseAbi([
    'function getReserves() view returns (uint112, uint112, uint32)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
]);
export const factoryAbi = parseAbi([
    'function getPair(address, address) view returns (address)',
]);

// 事件签名哈希（与合约事件逐字段对齐，改合约必须同步这里）
export const DEPOSIT_EVENT = 'Deposit(uint256,uint256,address,address,address,uint256)';
export const BURN_EVENT = 'BurnRequest(uint256,bytes32,address,uint256,address,uint256)';
