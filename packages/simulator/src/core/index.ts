/**
 * Core module re-exports
 *
 * This module provides the shared simulation logic used by both
 * the CLI (main.ts) and library (simulator.ts) entry points.
 */

// Types
export type { Logger, SimulationContext, GovernanceSimulationResult } from "./types";
export { nullLogger } from "./types";

// Constants
export {
    TUPLE_TYPES,
    bridgeABIs,
    messageIndex,
    GAS_LIMIT,
    EIP7825_TX_GAS_CAP,
    TX_GAS_LIMIT_BUFFER,
    MAX_MAINNET_TX_GAS,
    CCIP_ROUTER,
    CCIP_CHAIN_SELECTORS,
} from "./constants";

// Gas limit checks (EIP-7825)
export { checkTxGasCap, describeGasFailure, toGasHex } from "./gas";
export type { GasCapCheck, GasTxRequest } from "./gas";

// Proposal functions
export {
    getProposal,
    selectorOfSig,
    extractBridgedProposal,
    extractCCIPBridgedProposal,
    detectL2Chains,
    targetToL2Chain,
    isCCIPTarget,
    ccipTargetToL2Chain,
    parseProposalCalldata,
} from "./proposals";
export type { ProposalDetails } from "./proposals";

// Simulation functions
export {
    setupDelegation,
    simulateGovernance,
    runGovernanceFlow,
    simulateBridging,
    simulateL2,
    simulateCCIPL2,
    runDirect,
    runDirectWithL2,
    submitProposalFromCalldata,
} from "./simulation";

// L2→L1 relay
export { simulateL2ToL1Messages } from "./l2-to-l1";
