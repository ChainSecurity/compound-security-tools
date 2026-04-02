/**
 * Proposal fetching and parsing utilities
 */

import { ethers, AbiCoder, Interface, id } from "ethers";
import { governorABI } from "../abis";
import { zip } from "../utils";
import { loadConfig } from "../config";
import type { Proposal } from "../types";
import { TUPLE_TYPES, bridgeABIs, messageIndex, CCIP_ROUTER, CCIP_CHAIN_SELECTORS } from "./constants";

const config = loadConfig();
const coder = AbiCoder.defaultAbiCoder();

/**
 * Fetch proposal details from the governor contract
 */
export async function getProposal(
    proposalId: string,
    provider: ethers.JsonRpcProvider
): Promise<Proposal> {
    const governor = new ethers.Contract(
        config.chains.mainnet.governorAddress!,
        governorABI,
        provider,
    );

    const proposal = await governor.proposalDetails(proposalId);
    return {
        targets: proposal[0],
        values: proposal[1],
        calldatas: proposal[2],
    };
}

/**
 * Get the function selector from a signature
 */
export function selectorOfSig(sig: string): string {
    return id(sig).slice(0, 10);
}

/**
 * Extract the bridged proposal from a bridge call's calldata
 */
export function extractBridgedProposal(calldata: string, chain: string): Proposal {
    if (!bridgeABIs[chain]) {
        throw new Error(`Missing ABI for ${chain}`);
    }
    if (messageIndex[chain] === undefined) {
        throw new Error(`Missing messageIndex for ${chain}`);
    }

    const iface = new Interface(bridgeABIs[chain] as ethers.InterfaceAbi);
    const bridgeCall = iface.parseTransaction({ data: calldata });
    const decodedProposal = coder.decode(
        TUPLE_TYPES,
        bridgeCall!.args[messageIndex[chain]!],
    );

    const calldatas = zip(decodedProposal[2] as string[], decodedProposal[3] as string[]).map(
        (entry) => selectorOfSig(entry[0]) + entry[1].slice(2),
    );

    return {
        targets: decodedProposal[0] as string[],
        values: decodedProposal[1] as bigint[],
        calldatas,
    };
}

// ============ CCIP Support ============

const ccipIface = new Interface([
    "function ccipSend(uint64 destinationChainSelector, tuple(bytes receiver, bytes data, tuple(address token, uint256 amount)[] tokenAmounts, address feeToken, bytes extraArgs) message) external payable returns (bytes32)",
]);

/**
 * Check if a target address is the CCIP Router
 */
export function isCCIPTarget(target: string): boolean {
    return target.toLowerCase() === CCIP_ROUTER.toLowerCase();
}

/**
 * Get the L2 chain name for a CCIP ccipSend call by parsing its calldata
 */
export function ccipTargetToL2Chain(calldata: string): string | undefined {
    try {
        const parsed = ccipIface.parseTransaction({ data: calldata });
        if (!parsed) return undefined;
        const chainSelector = parsed.args[0].toString();
        return CCIP_CHAIN_SELECTORS[chainSelector];
    } catch {
        return undefined;
    }
}

/**
 * Extract a bridged proposal from CCIP ccipSend calldata
 *
 * The CCIP message data field contains:
 *   abi.encode(address[] targets, uint256[] values, string[] signatures, bytes[] calldatas)
 */
export function extractCCIPBridgedProposal(calldata: string): Proposal {
    const parsed = ccipIface.parseTransaction({ data: calldata });
    if (!parsed) throw new Error("Failed to parse ccipSend calldata");

    const message = parsed.args[1];
    const data: string = message.data;

    const decoded = coder.decode(TUPLE_TYPES, data);
    const calldatas = zip(decoded[2] as string[], decoded[3] as string[]).map(
        (entry) => selectorOfSig(entry[0]) + entry[1].slice(2),
    );

    return {
        targets: decoded[0] as string[],
        values: decoded[1] as bigint[],
        calldatas,
    };
}

// ============ Chain Detection ============

/**
 * Detect which L2 chains are targeted by a proposal
 */
export function detectL2Chains(proposal: Proposal): string[] {
    const chains: string[] = [];
    for (let i = 0; i < proposal.targets.length; i++) {
        const target = proposal.targets[i]!;
        if (target === config.chains.scroll?.bridge) chains.push("scroll");
        else if (target === config.chains.arbitrum?.bridge) chains.push("arbitrum");
        else if (target === config.chains.optimism?.bridge) chains.push("optimism");
        else if (target === config.chains.base?.bridge) chains.push("base");
        else if (target === config.chains.mantle?.bridge) chains.push("mantle");
        else if (target === config.chains.linea?.bridge) chains.push("linea");
        else if (target === config.chains.unichain?.bridge) chains.push("unichain");
        else if (target === config.chains.polygon?.bridge) chains.push("polygon");
        else if (isCCIPTarget(target)) {
            const chain = ccipTargetToL2Chain(proposal.calldatas[i]!);
            if (chain) chains.push(chain);
        }
    }
    return [...new Set(chains)]; // Remove duplicates
}

/**
 * Map a target address to its L2 chain name
 */
export function targetToL2Chain(target: string): string | undefined {
    if (target === config.chains.scroll?.bridge) return "scroll";
    if (target === config.chains.arbitrum?.bridge) return "arbitrum";
    if (target === config.chains.optimism?.bridge) return "optimism";
    if (target === config.chains.base?.bridge) return "base";
    if (target === config.chains.mantle?.bridge) return "mantle";
    if (target === config.chains.linea?.bridge) return "linea";
    if (target === config.chains.unichain?.bridge) return "unichain";
    if (target === config.chains.polygon?.bridge) return "polygon";
    return undefined;
}

/**
 * Proposal details for direct simulation
 */
export interface ProposalDetails {
    targets: string[];
    values: bigint[];
    calldatas: string[];
    descriptionHash?: string;
}

/**
 * Parse propose() calldata to extract proposal details
 */
export function parseProposalCalldata(calldata: string): ProposalDetails {
    const iface = new Interface(governorABI);
    const parsed = iface.parseTransaction({ data: calldata });

    if (!parsed || parsed.name !== "propose") {
        throw new Error("Invalid calldata: expected propose() function call");
    }

    const [targets, values, calldatas, description] = parsed.args;

    return {
        targets: targets as string[],
        values: (values as bigint[]).map(v => BigInt(v)),
        calldatas: calldatas as string[],
        descriptionHash: description as string,
    };
}
