/**
 * Shared constants used by simulation logic
 */

import {
    scrollBridgeABI,
    arbitrumBridgeABI,
    optimismBridgeABI,
    baseBridgeABI,
    mantleBridgeABI,
    lineaBridgeABI,
    unichainBridgeABI,
    polygonBridgeABI,
} from "../abis";

/**
 * Tuple types used for decoding bridged proposal messages
 */
export const TUPLE_TYPES = [
    "address[]",
    "uint256[]",
    "string[]",
    "bytes[]",
] as const;

/**
 * Bridge ABIs for each L2 chain
 */
export const bridgeABIs: Record<string, unknown[]> = {
    scroll: scrollBridgeABI,
    arbitrum: arbitrumBridgeABI,
    optimism: optimismBridgeABI,
    base: baseBridgeABI,
    mantle: mantleBridgeABI,
    linea: lineaBridgeABI,
    unichain: unichainBridgeABI,
    polygon: polygonBridgeABI,
};

/**
 * Message index in bridge function calls for each chain
 *
 * Example for Scroll: sendMessage(address _to, uint256 _value, bytes memory _message, uint256 _gasLimit)
 * The message is at index 2.
 */
export const messageIndex: Record<string, number> = {
    scroll: 2,
    arbitrum: 7,
    optimism: 1,
    base: 1,
    mantle: 1,
    linea: 2,
    unichain: 1,
    polygon: 1,
};

/**
 * Gas limit warning threshold
 */
export const GAS_LIMIT = 10_000_000;

/**
 * EIP-7825 (Fusaka/Osaka) per-transaction gas limit cap: 2^24.
 *
 * A mainnet transaction whose gas limit exceeds this is invalid, so any proposal
 * needing more than this to execute cannot be executed in a single transaction.
 */
export const EIP7825_TX_GAS_CAP = 16_777_216;

/**
 * Safety buffer subtracted from the EIP-7825 cap when simulating mainnet
 * transactions.
 *
 * We deliberately simulate with LESS gas than mainnet allows so that proposals
 * landing near the cap fail here rather than passing simulation and reverting
 * on-chain. 2^18 = 262,144 (~1.6% of the cap).
 */
export const TX_GAS_LIMIT_BUFFER = 262_144;

/**
 * Gas limit used for mainnet transactions during simulation.
 *
 * NOTE: do not raise this to `defaults.gas`. Sending with an unbounded gas limit
 * (or letting the node auto-estimate) hides EIP-7825 violations entirely: the
 * node happily accepts a limit above the cap and the simulation reports SUCCESS
 * for a transaction mainnet would reject.
 */
export const MAX_MAINNET_TX_GAS = EIP7825_TX_GAS_CAP - TX_GAS_LIMIT_BUFFER;

/**
 * CCIP Router address on Ethereum mainnet
 */
export const CCIP_ROUTER = "0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D";

/**
 * CCIP chain selectors → config chain names
 *
 * Maps Chainlink CCIP destination chain selectors to the chain names
 * used in compound-config.json. Add entries here to support new CCIP
 * destination chains.
 */
export const CCIP_CHAIN_SELECTORS: Record<string, string> = {
    "6916147374840168594": "ronin",
};
