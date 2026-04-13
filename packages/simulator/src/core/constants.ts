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
