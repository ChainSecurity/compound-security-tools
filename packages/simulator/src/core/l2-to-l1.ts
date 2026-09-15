/**
 * L2→L1 message relay simulation
 *
 * After L2 execution, scans the execution receipt for outbound cross-chain
 * messages and replays them on the mainnet fork by impersonating the
 * L1 messenger — bypassing the challenge period and finalization steps
 * that would be required on a live network.
 *
 * Supported chains: OP-Stack (Optimism, Base, Mantle, Unichain), Arbitrum
 */

import { ethers, AbiCoder } from "ethers";
import { loadConfig, getSimulatorRpcUrl } from "../config";
import { getRevertReason } from "../utils";
import type { ChainExecutionResult } from "../types";
import type { SimulationContext } from "./types";

const config = loadConfig();

// OP-Stack L2CrossDomainMessenger predeploy — identical address on every OP-Stack chain
const OP_L2_MESSENGER = "0x4200000000000000000000000000000000000007";

// ArbSys predeploy on Arbitrum (emits L2ToL1Tx events)
const ARB_SYS = "0x0000000000000000000000000000000000000064";

// Arbitrum One Outbox on Ethereum mainnet (canonical, immutable)
const ARB_OUTBOX = "0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840";

// SentMessage(address indexed target, address sender, bytes message, uint256 messageNonce, uint256 gasLimit)
const OP_SENT_MESSAGE_TOPIC = ethers.id("SentMessage(address,address,bytes,uint256,uint256)");

// L2ToL1Tx(address caller, address indexed destination, uint64 indexed hash,
//          uint64 indexed position, uint256 arbBlockNum, uint256 ethBlockNum,
//          uint256 timestamp, uint256 callvalue, bytes data)
const ARB_L2_TO_L1_TX_TOPIC = ethers.id(
    "L2ToL1Tx(address,address,uint64,uint64,uint256,uint256,uint256,uint256,bytes)"
);

interface OutboundMessage {
    target: string;  // L1 contract to call
    sender: string;  // L2 contract that sent the message (becomes xDomainMessageSender on L1)
    message: string; // Calldata for target
    value: bigint;   // ETH value (0 for ERC-20 bridges)
}

function parseOPStackMessages(receipt: ethers.TransactionReceipt): OutboundMessage[] {
    const coder = AbiCoder.defaultAbiCoder();
    const messages: OutboundMessage[] = [];

    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== OP_L2_MESSENGER.toLowerCase()) continue;
        if (log.topics[0] !== OP_SENT_MESSAGE_TOPIC) continue;

        // topics[1] = target (indexed address)
        const target = ethers.getAddress("0x" + log.topics[1]!.slice(26));
        // data = abi.encode(sender, message, messageNonce, gasLimit)
        const [sender, message] = coder.decode(["address", "bytes", "uint256", "uint256"], log.data);

        messages.push({
            target,
            sender: sender as string,
            message: message as string,
            value: 0n,
        });
    }

    return messages;
}

function parseArbitrumMessages(receipt: ethers.TransactionReceipt): OutboundMessage[] {
    const coder = AbiCoder.defaultAbiCoder();
    const messages: OutboundMessage[] = [];

    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== ARB_SYS.toLowerCase()) continue;
        if (log.topics[0] !== ARB_L2_TO_L1_TX_TOPIC) continue;

        // topics[1] = destination (indexed), topics[2] = hash, topics[3] = position
        const destination = ethers.getAddress("0x" + log.topics[1]!.slice(26));
        // data = abi.encode(caller, arbBlockNum, ethBlockNum, timestamp, callvalue, data)
        const [caller, , , , callvalue, calldata] = coder.decode(
            ["address", "uint256", "uint256", "uint256", "uint256", "bytes"],
            log.data
        );

        messages.push({
            target: destination,
            sender: caller as string,
            message: calldata as string,
            value: callvalue as bigint,
        });
    }

    return messages;
}

/**
 * Simulate relay of L2→L1 messages onto the mainnet fork.
 *
 * Called after L2 execution succeeds. Scans the executeProposal() receipt for
 * outbound cross-chain message events, then replays each one on the mainnet
 * fork by impersonating the appropriate L1 messenger contract.
 *
 * For OP-Stack chains: impersonates L1CrossDomainMessenger and sets its
 * xDomainMsgSender storage slot so that L1 bridge contracts accept the call.
 *
 * For Arbitrum: impersonates the Outbox and calls the destination directly.
 */
export async function simulateL2ToL1Messages(
    l2Chain: string,
    l2ExecuteTxHash: string,
    ctx: SimulationContext
): Promise<ChainExecutionResult[]> {
    const { backend, logger } = ctx;

    const l2Provider = backend.getProvider(l2Chain);
    const receipt = await l2Provider.getTransactionReceipt(l2ExecuteTxHash);
    if (!receipt || receipt.status !== 1) return [];

    const isOPStack = ["optimism", "base", "mantle", "unichain"].includes(l2Chain);
    const isArbitrum = l2Chain === "arbitrum";

    if (!isOPStack && !isArbitrum) return [];

    let messages: OutboundMessage[];
    let l1MessengerAddress: string;

    if (isOPStack) {
        messages = parseOPStackMessages(receipt);
        if (messages.length === 0) return [];

        // Resolve the L1CrossDomainMessenger via the L2 messenger's OTHER_MESSENGER() getter.
        // Both L1 and L2 CrossDomainMessenger inherit the same base contract so the getter
        // is the canonical way to discover the paired contract on the other chain.
        const l2Messenger = new ethers.Contract(
            OP_L2_MESSENGER,
            ["function OTHER_MESSENGER() external view returns (address)"],
            l2Provider
        );
        l1MessengerAddress = await l2Messenger.OTHER_MESSENGER();
    } else {
        messages = parseArbitrumMessages(receipt);
        if (messages.length === 0) return [];
        l1MessengerAddress = ARB_OUTBOX;
    }

    logger.section(`${l2Chain} → mainnet`);
    logger.info("Outbound messages", messages.length);

    const results: ChainExecutionResult[] = [];
    const mainnetConfig = config.chains.mainnet;
    const l1Provider = backend.getProvider("mainnet");

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!;
        logger.step(`Relaying message ${i + 1}/${messages.length} to ${msg.target}`);

        if (isOPStack) {
            // Set xDomainMsgSender on L1CrossDomainMessenger to the originating L2 contract
            // (e.g. L2StandardBridge) so that L1 bridge contracts can verify the caller.
            // The CrossDomainMessenger base contract stores xDomainMsgSender at slot 0xcc —
            // the same slot used on the L2 side (confirmed empirically by the L1→L2 code).
            await backend.setStorageAt(
                "mainnet",
                l1MessengerAddress,
                "0x00000000000000000000000000000000000000000000000000000000000000cc",
                ethers.zeroPadValue(msg.sender, 32)
            );
        }

        await backend.impersonateAccount("mainnet", l1MessengerAddress);

        const txParams: Parameters<typeof backend.sendTransaction>[1] = {
            from: l1MessengerAddress,
            to: msg.target,
            data: msg.message,
            gas: config.defaults.gas,
            gasPrice: config.defaults.gasPrice,
        };
        if (msg.value > 0n) {
            txParams.value = "0x" + msg.value.toString(16);
        }

        const txHash = await backend.sendTransaction("mainnet", txParams);
        logger.tx("Relay", txHash);

        const relayReceipt = await l1Provider.waitForTransaction(txHash);
        const success = relayReceipt?.status === 1;
        const gasUsed = relayReceipt?.gasUsed;

        let revertReason: string | undefined;
        if (!success && txHash) {
            revertReason = await getRevertReason(l1Provider, txHash);
            logger.error(`Relay failed: ${revertReason ?? "unknown"}`);
        } else {
            logger.done("Relay succeeded");
        }

        results.push({
            chain: `${l2Chain}→mainnet`,
            chainId: mainnetConfig.chainId,
            success: success ?? false,
            timelockAddress: mainnetConfig.timelockAddress,
            executions: [{
                index: i,
                target: msg.target,
                value: msg.value,
                calldata: msg.message,
                success: success ?? false,
                gasUsed,
                txHash,
                revertReason,
            }],
            totalGasUsed: gasUsed,
            persisted: true,
            rpcUrl: getSimulatorRpcUrl("mainnet"),
        });
    }

    return results;
}
