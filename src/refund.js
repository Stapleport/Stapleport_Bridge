// 退款腿中继（时间有效性闭环）：过期消息在落地时被合约分支标记为终态并发射指令事件，
// relayer 次轮拾取这些事件执行对应的退款动作。四向：
//   dir1 hub DepositRefunded(chainIndex,seq)         → 源链 Vault.refundDeposit(seq)
//   dir2 源链 Vault.ReleaseSkipped(...outId...)      → hub executeBurnRefund(重铸毛额 spToken)
//   dir3 外链 OutVault.OutMintRefunded(chainIndex,inId) → hub executeOutRefund(ERC20/native)
//        同链 native/erc20 双族共一 OutVault，事件无族标记 ⇒ 视图消歧（outMinted/outMintedErc20）
//   dir4 hub OutReleaseSkipped(...outBurnId...)      → 外链 OutVault.executeOutBurnRefund
//
// 可靠性设计与 relay.js 同口径：cursor 存 D1；ops INSERT OR IGNORE 抢占 + 合约幂等旗标双保险；
// 广播后短轮询幂等视图对账，未确认留给下一轮；失败 failOp 计入 attempts，超 maxAttempts 告警挂起。
// 退款腿自身不带二级 deadline（终态救援语义，失败保持 pending 重试至人工）。
import { encodeFunctionData, decodeEventLog, decodeFunctionResult, parseAbiItem, getEventSelector } from 'viem';
import {
    vaultAbi, spBridgeAbi, outVaultAbi,
    DEPOSIT_REFUNDED_EVENT, RELEASE_SKIPPED_EVENT, OUT_MINT_REFUNDED_EVENT, OUT_RELEASE_SKIPPED_EVENT,
} from './lib/abi.js';
import { rpc, callRaw, latestBlock, toHex } from './lib/rpc.js';
import { sendTx } from './lib/tx.js';
import { getCursor, setCursor, claimOp, finishOp, failOp, setFeeState, bumpStuckCount } from './lib/store.js';
import { notify } from './notify.js';
import { ZERO_ADDRESS } from '@stapleport/worker-kit';

const DEPOSIT_REFUNDED_TOPIC = getEventSelector(parseAbiItem(`event ${DEPOSIT_REFUNDED_EVENT}`));
const RELEASE_SKIPPED_TOPIC = getEventSelector(parseAbiItem(`event ${RELEASE_SKIPPED_EVENT}`));
const OUT_MINT_REFUNDED_TOPIC = getEventSelector(parseAbiItem(`event ${OUT_MINT_REFUNDED_EVENT}`));
const OUT_RELEASE_SKIPPED_TOPIC = getEventSelector(parseAbiItem(`event ${OUT_RELEASE_SKIPPED_EVENT}`));

// 出向通道按族定位（token=address(0) 表 native 族、非零表 ERC20 族；§1.2 OutReleaseSkipped.token 语义）
function outChannelFor(cfg, chainIndex, token) {
    const erc = token && String(token) !== ZERO_ADDRESS;
    return cfg.outChannels.find((c) => String(c.chainIndex) === String(chainIndex) && Boolean(c.srcToken) === erc)
        || cfg.outChannels.find((c) => String(c.chainIndex) === String(chainIndex));
}

// 退款动作描述：目标链/合约/编码 + 幂等视图（发送前预查 + 收尾对账共用）
function resolveRefund(cfg, direction, p) {
    const hub = cfg.hub;
    if (direction === 'refund_deposit') {
        const src = cfg.srcChains[String(p.chainIndex)];
        const ch = cfg.channels.find((c) => String(c.chainIndex) === String(p.chainIndex));
        if (!src?.rpcUrl || !ch?.vault) return null;
        const seq = BigInt(p.seq);
        return {
            rpcUrl: src.rpcUrl, to: ch.vault, abi: vaultAbi, fn: 'refundDeposit', args: [seq],
            viewTo: ch.vault, viewAbi: vaultAbi, viewFn: 'depositRefunded', viewArgs: [seq],
        };
    }
    if (direction === 'refund_burn') {
        const seq = BigInt(p.outId);
        return {
            rpcUrl: hub.rpcUrl, to: hub.spBridge, abi: spBridgeAbi, fn: 'executeBurnRefund',
            args: [BigInt(p.chainIndex), p.spToken, seq, p.recipient, BigInt(p.amount)],
            viewTo: hub.spBridge, viewAbi: spBridgeAbi, viewFn: 'burnRefunded', viewArgs: [seq],
        };
    }
    if (direction === 'refund_outlock' || direction === 'refund_outlock_e20') {
        const erc = direction === 'refund_outlock_e20';
        const seq = BigInt(p.seq);
        return {
            rpcUrl: hub.rpcUrl, to: hub.spBridge, abi: spBridgeAbi,
            fn: erc ? 'executeOutRefundERC20' : 'executeOutRefund', args: [seq],
            viewTo: hub.spBridge, viewAbi: spBridgeAbi,
            viewFn: erc ? 'outLockErc20Refunded' : 'outLockRefunded', viewArgs: [seq],
        };
    }
    if (direction === 'refund_outburn') {
        const src = cfg.srcChains[String(p.chainIndex)];
        const ch = outChannelFor(cfg, p.chainIndex, p.token);
        if (!src?.rpcUrl || !ch?.vault) return null;
        const id = BigInt(p.outBurnId);
        return {
            rpcUrl: src.rpcUrl, to: ch.vault, abi: outVaultAbi, fn: 'executeOutBurnRefund', args: [id],
            viewTo: ch.vault, viewAbi: outVaultAbi, viewFn: 'outBurnRefunded', viewArgs: [id],
        };
    }
    return null;
}

// 出向退款族消歧（纯判定）：channels=该 chainIndex 的出向通道集合；minted/mintedErc20=同一
// OutVault 两幂等视图读数（outMinted/outMintedErc20）。OutMintRefunded 无族标记，同链双族共
// vault ⇒ 以「哪个视图为 true」定族；异常态（均 false / 双 true / 视图族无对应通道配置）返回
// err+direction（direction 为 failOp 挂账锚），调用方不硬发、计次转人工。
export function outMintFamilyOf(channels, minted, mintedErc20) {
    const nativeDir = 'refund_outlock';
    const erc20Dir = 'refund_outlock_e20';
    const hasNative = channels.some((c) => !c.srcToken);
    const hasErc20 = channels.some((c) => Boolean(c.srcToken));
    if (!minted && !mintedErc20) {
        return { err: 'both outMinted views false (event must set one)', direction: hasNative ? nativeDir : erc20Dir };
    }
    if (minted && mintedErc20) {
        return { err: 'ambiguous family: both outMinted views true', direction: nativeDir };
    }
    const erc20 = Boolean(mintedErc20);
    const direction = erc20 ? erc20Dir : nativeDir;
    if (erc20 && !hasErc20) return { err: 'erc20 family but no erc20 outChannel configured', direction };
    if (!erc20 && !hasNative) return { err: 'native family but no native outChannel configured', direction };
    return { direction, erc20 };
}

async function readOutMintedFlag(rpcUrl, vault, fn, inId) {
    const raw = await callRaw(rpcUrl, vault,
        encodeFunctionData({ abi: outVaultAbi, functionName: fn, args: [BigInt(inId)] }));
    return decodeFunctionResult({ abi: outVaultAbi, functionName: fn, data: raw });
}

async function isRefunded(cfg, spec) {
    const raw = await callRaw(spec.rpcUrl, spec.viewTo,
        encodeFunctionData({ abi: spec.viewAbi, functionName: spec.viewFn, args: spec.viewArgs }));
    return decodeFunctionResult({ abi: spec.viewAbi, functionName: spec.viewFn, data: raw });
}

async function savePayload(db, direction, key, p) {
    await db.prepare('update ops set payload=? where direction=? and op_key=?')
        .bind(JSON.stringify(p), direction, key).run();
}

// 单次退款尝试（导出供单测：卡死停试腿）。
export async function attemptRefund(env, cfg, wallet, db, direction, key, p) {
    const spec = resolveRefund(cfg, direction, p);
    if (!spec) {
        await failOp(db, direction, key, 'no rpc/vault', cfg.maxAttempts);
        return;
    }
    if (cfg.dryRun) {
        await finishOp(db, direction, key, 'dry-run');
        return;
    }
    const data = encodeFunctionData({ abi: spec.abi, functionName: spec.fn, args: spec.args });
    try {
        const txHash = await sendTx(spec.rpcUrl, wallet, { to: spec.to, data }, cfg);
        if (txHash == null) {
            // 预估失败跳过（tx.js 统一收口，发前预估门）：连续失败计次，达阈值写卡死终态停试（追派二）。
            // 链上语义：B 侧已裁决终态、A 侧本金+费滞留 escrow，无资金风险，恶意 payer 自担。
            const n = await bumpStuckCount(db, direction, key);
            if (n >= (cfg.stuckThreshold ?? 5)) {
                await setFeeState(db, direction, key, 'refund_stuck');
                await notify(env, { event: `${direction}_stuck`, chainIndex: String(p.chainIndex ?? ''), key, note: 'estimate-fail >= threshold, terminal stop' });
            }
            return;
        }
        console.log(`[bridge] ${spec.fn} 广播: ${txHash}`);
        await refundSettle(env, cfg, db, direction, key, spec, txHash);
    } catch (e) {
        console.log(`[bridge] ${spec.fn} 异常 key=${key}: ${String(e.message).slice(0, 200)}`);
        const exhausted = await failOp(db, direction, key, e, cfg.maxAttempts);
        if (exhausted) {
            await notify(env, { event: `${direction}_stuck`, chainIndex: String(p.chainIndex ?? ''), key, error: String(e.message).slice(0, 200) });
        }
    }
}

// 广播后短轮询幂等旗标（拿不到留给下一轮重试通道对账；合约旗标拦重放）
function refundSettle(env, cfg, db, direction, key, spec, txHash) {
    return (async () => {
        if (txHash == null) return; // 估算跳过/dryRun：未广播，不发假通知、不轮询幂等位
        for (let i = 0; i < 3; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            if (await isRefunded(cfg, spec)) {
                await finishOp(db, direction, key, txHash ?? 'confirmed');
                await notify(env, { event: `${direction}_sent`, key, tx: txHash });
                return;
            }
        }
        await notify(env, { event: `${direction}_broadcast`, key, tx: txHash, note: '回执未确认，下轮对账' });
    })();
}

// pending 退款重试：幂等旗标命中 → done；否则用 ops.payload 里的参数重发
async function retryPendingRefunds(env, cfg, wallet, db) {
    const rows = await db.prepare(
        `select direction, op_key, payload, attempts from ops where status='pending' and direction like 'refund_%' and (fee_state is null or fee_state not in ('refund_stuck','claim_stuck'))`
    ).all();
    for (const row of rows.results ?? []) {
        try {
            const p = JSON.parse(row.payload || '{}');
            const spec = resolveRefund(cfg, row.direction, p);
            if (!spec) continue; // 配置缺失（拓扑未齐备），等下一轮
            if (await isRefunded(cfg, spec)) {
                await finishOp(db, row.direction, row.op_key, 'confirmed-on-retry');
                continue;
            }
            if (row.attempts >= cfg.maxAttempts) continue;
            await attemptRefund(env, cfg, wallet, db, row.direction, row.op_key, p);
        } catch (e) {
            await failOp(db, row.direction, row.op_key, e, cfg.maxAttempts);
        }
    }
}

const uniqChainIndexes = (arr) => [...new Set(arr.map((c) => String(c.chainIndex)))];
const hubConfirmations = (env) => BigInt(JSON.parse(env.SRC_CHAINS || '{}')?.hub?.confirmations ?? 2);

// hub：DepositRefunded（dir1）+ OutReleaseSkipped（dir4）双 topic 单游标
async function refundHubScan(env, cfg, wallet, db) {
    const hub = cfg.hub;
    if (!hub.rpcUrl || !hub.spBridge) return;
    const head = await latestBlock(hub.rpcUrl);
    const safeTo = head - hubConfirmations(env);
    const cursor = await getCursor(db, 'hub', 'refund_hub');
    if (cursor === null) {
        await setCursor(db, 'hub', 'refund_hub', safeTo);
        console.log(`[bridge] hub 退款游标基线 → ${safeTo}`);
        return;
    }
    if (safeTo <= cursor) return;

    const logs = await rpc(hub.rpcUrl, 'eth_getLogs', [{
        address: hub.spBridge,
        topics: [[DEPOSIT_REFUNDED_TOPIC, OUT_RELEASE_SKIPPED_TOPIC]],
        fromBlock: toHex(cursor + 1n),
        toBlock: toHex(safeTo),
    }]);
    for (const log of logs) {
        let ev;
        try {
            ev = decodeEventLog({ abi: spBridgeAbi, data: log.data, topics: log.topics });
        } catch {
            continue;
        }
        if (ev.eventName === 'DepositRefunded') {
            const { chainIndex, seq } = ev.args;
            const key = `${chainIndex}:${seq}`;
            if (!(await claimOp(db, 'refund_deposit', key))) continue;
            const p = { chainIndex: String(chainIndex), seq: String(seq) };
            const spec = resolveRefund(cfg, 'refund_deposit', p);
            if (spec && await isRefunded(cfg, spec)) {
                await finishOp(db, 'refund_deposit', key, 'already-refunded');
                continue;
            }
            await savePayload(db, 'refund_deposit', key, p);
            await attemptRefund(env, cfg, wallet, db, 'refund_deposit', key, p);
        } else if (ev.eventName === 'OutReleaseSkipped') {
            const { chainIndex, outBurnId, token, recipient, amount } = ev.args;
            const key = `${chainIndex}:${outBurnId}`;
            if (!(await claimOp(db, 'refund_outburn', key))) continue;
            const p = { chainIndex: String(chainIndex), outBurnId: String(outBurnId), token, recipient, amount: String(amount) };
            const spec = resolveRefund(cfg, 'refund_outburn', p);
            if (spec && await isRefunded(cfg, spec)) {
                await finishOp(db, 'refund_outburn', key, 'already-refunded');
                continue;
            }
            await savePayload(db, 'refund_outburn', key, p);
            await attemptRefund(env, cfg, wallet, db, 'refund_outburn', key, p);
        }
    }
    await setCursor(db, 'hub', 'refund_hub', safeTo);
}

// 入向源链 vault：ReleaseSkipped → dir2（hub 重铸毛额）
async function refundReleaseScan(env, cfg, wallet, db) {
    for (const idx of uniqChainIndexes(cfg.channels)) {
        const src = cfg.srcChains[idx];
        const ch = cfg.channels.find((c) => String(c.chainIndex) === idx);
        if (!src?.rpcUrl || !ch?.vault) continue;
        try {
            const head = await latestBlock(src.rpcUrl);
            const safeTo = head - src.confirmations;
            const curKey = `src:${idx}`;
            const cursor = await getCursor(db, curKey, 'refund_release');
            if (cursor === null) {
                await setCursor(db, curKey, 'refund_release', safeTo);
                continue;
            }
            if (safeTo <= cursor) continue;

            const logs = await rpc(src.rpcUrl, 'eth_getLogs', [{
                address: ch.vault,
                topics: [RELEASE_SKIPPED_TOPIC],
                fromBlock: toHex(cursor + 1n),
                toBlock: toHex(safeTo),
            }]);
            for (const log of logs) {
                let ev;
                try {
                    ev = decodeEventLog({ abi: vaultAbi, data: log.data, topics: log.topics });
                } catch {
                    continue;
                }
                if (ev.eventName !== 'ReleaseSkipped') continue;
                // 事件第 3 字段（ABI 名 spToken）实为**源链 token**：vault_in.executeRelease
                // 过期分支发射时填的是 executeRelease 的 token（源链 ERC20），源 vault 无 hub
                // spToken 概念。hub executeBurnRefund 以 channelBySp[spToken][chainIndex] 取通道
                // ⇒ 必须以 (chainIndex, srcToken) 反查回 hub spToken 再入 payload/args。
                const { chainIndex, outId, spToken: srcToken, recipient, amount } = ev.args;
                const key = `${chainIndex}:${outId}`;
                if (!(await claimOp(db, 'refund_burn', key))) continue;
                const ch = cfg.channels.find((c) => String(c.chainIndex) === String(chainIndex)
                    && String(c.srcToken).toLowerCase() === String(srcToken).toLowerCase());
                if (!ch?.spToken) {
                    // 反查未命中（通道配置缺失）= 不硬发、failOp 计次转人工，禁静默跳过
                    await failOp(db, 'refund_burn', key,
                        `no channel for srcToken ${srcToken} chainIndex ${chainIndex}`, cfg.maxAttempts);
                    continue;
                }
                const p = {
                    chainIndex: String(chainIndex), outId: String(outId),
                    srcToken, spToken: ch.spToken, recipient, amount: String(amount),
                };
                const spec = resolveRefund(cfg, 'refund_burn', p);
                if (spec && await isRefunded(cfg, spec)) {
                    await finishOp(db, 'refund_burn', key, 'already-refunded');
                    continue;
                }
                await savePayload(db, 'refund_burn', key, p);
                await attemptRefund(env, cfg, wallet, db, 'refund_burn', key, p);
            }
            await setCursor(db, curKey, 'refund_release', safeTo);
        } catch (e) {
            console.log(`[bridge] refund_release chainIndex=${idx} tick 异常：${String(e.message).slice(0, 120)}`);
        }
    }
}

// 出向外链 OutVault：OutMintRefunded → dir3（hub 回付 locker）
// 事件无族标记、同链 native/erc20 双族共一 OutVault 实例 ⇒ 逐事件视图消歧（读同一 OutVault
// 的 outMinted/outMintedErc20，事件当笔必置位其一）定族，再选 refund 腿与 direction。
async function refundOutMintScan(env, cfg, wallet, db) {
    for (const idx of uniqChainIndexes(cfg.outChannels)) {
        const src = cfg.srcChains[idx];
        const chans = cfg.outChannels.filter((c) => String(c.chainIndex) === idx);
        const ch = chans.find((c) => c.vault);
        if (!src?.rpcUrl || !ch?.vault) continue;
        try {
            const head = await latestBlock(src.rpcUrl);
            const safeTo = head - src.confirmations;
            const curKey = `src:${idx}`;
            const cursor = await getCursor(db, curKey, 'refund_outmint');
            if (cursor === null) {
                await setCursor(db, curKey, 'refund_outmint', safeTo);
                continue;
            }
            if (safeTo <= cursor) continue;

            const logs = await rpc(src.rpcUrl, 'eth_getLogs', [{
                address: ch.vault,
                topics: [OUT_MINT_REFUNDED_TOPIC],
                fromBlock: toHex(cursor + 1n),
                toBlock: toHex(safeTo),
            }]);
            for (const log of logs) {
                let ev;
                try {
                    ev = decodeEventLog({ abi: outVaultAbi, data: log.data, topics: log.topics });
                } catch {
                    continue;
                }
                if (ev.eventName !== 'OutMintRefunded') continue;
                const { chainIndex, inId } = ev.args;
                const key = `${chainIndex}:${inId}`;
                // 视图消歧：读同一 OutVault 两幂等位（native/erc20 独立键空间）
                const [mintedNative, mintedErc20] = await Promise.all([
                    readOutMintedFlag(src.rpcUrl, ch.vault, 'outMinted', inId),
                    readOutMintedFlag(src.rpcUrl, ch.vault, 'outMintedErc20', inId),
                ]);
                const fam = outMintFamilyOf(chans, mintedNative, mintedErc20);
                if (fam.err) {
                    // 异常态：不硬发、failOp 计次转人工（禁静默跳过）；每次 tick 计次直至告警
                    await claimOp(db, fam.direction, key); // 确保 op 行存在（insert-or-ignore）
                    const exhausted = await failOp(db, fam.direction, key, fam.err, cfg.maxAttempts);
                    if (exhausted) {
                        await notify(env, { event: 'refund_outlock_stuck', chainIndex: String(chainIndex), key, error: fam.err });
                    }
                    continue;
                }
                const direction = fam.direction;
                if (!(await claimOp(db, direction, key))) continue;
                const p = { chainIndex: String(chainIndex), seq: String(inId) };
                const spec = resolveRefund(cfg, direction, p);
                if (spec && await isRefunded(cfg, spec)) {
                    await finishOp(db, direction, key, 'already-refunded');
                    continue;
                }
                await savePayload(db, direction, key, p);
                await attemptRefund(env, cfg, wallet, db, direction, key, p);
            }
            await setCursor(db, curKey, 'refund_outmint', safeTo);
        } catch (e) {
            console.log(`[bridge] refund_outmint chainIndex=${idx} tick 异常：${String(e.message).slice(0, 120)}`);
        }
    }
}

// tick 入口：先跑 pending 退款重试，再三个扫描面（hub/入向源链/出向外链）
export async function relayRefunds(env, cfg, wallet, db) {
    try {
        await retryPendingRefunds(env, cfg, wallet, db);
    } catch (e) {
        console.log(`[bridge] 退款重试异常：${String(e.message).slice(0, 120)}`);
    }
    for (const scan of [refundHubScan, refundReleaseScan, refundOutMintScan]) {
        try {
            await scan(env, cfg, wallet, db);
        } catch (e) {
            console.log(`[bridge] 退款扫描异常：${String(e.message).slice(0, 120)}`);
        }
    }
}
