// 通道键：channelKeyOf / outKeyOf（与合约 _key(chainIndex, srcToken) 同构，结果缓存 L1-5）。
import { keccak256, encodeAbiParameters } from 'viem';
// 2026-09-23 起收编 WorkerKit 单源（原仓内常量退役）
import { ZERO_ADDRESS } from '@stapleport/worker-kit';

export { ZERO_ADDRESS };

// channelKey 与合约同构：keccak256(abi.encode(chainIndex, srcToken))。
// 结果缓存（L1-5）：键 = 入参原样模板串（不归一化——入参形态差异只会多出重复缓存项，
// 不会串值：同键 ⇒ BigInt/地址串渲染相同 ⇒ 计算值恒同）；键空间=通道级有限集合。
const channelKeyCache = new Map();
export const channelKeyOf = (chainIndex, srcToken) => {
    const k = `${chainIndex}:${srcToken}`;
    let v = channelKeyCache.get(k);
    if (v === undefined) {
        v = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [BigInt(chainIndex), srcToken]));
        channelKeyCache.set(k, v);
    }
    return v;
};

// 出向通道键与合约同构：(chainIndex, address(0))——native 无 srcToken
export const outKeyOf = (chainIndex) => channelKeyOf(chainIndex, ZERO_ADDRESS);
