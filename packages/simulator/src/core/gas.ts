/**
 * Transaction gas limit checks (EIP-7825)
 *
 * EIP-7825 (Fusaka/Osaka) caps a single transaction's gas limit at 2^24. A proposal
 * whose execution needs more than that cannot be executed on mainnet at all, no
 * matter how much gas the sender is willing to pay for.
 *
 * This is easy to miss in simulation for two reasons:
 *
 *  1. `receipt.gasUsed` is NOT the quantity the cap constrains. It is reported net
 *     of EIP-3529 refunds and excludes the 1/64 reserves that EIP-150 requires to
 *     be present in the limit at every nested call but that are never spent. The
 *     minimum viable gas *limit* can sit hundreds of thousands of gas above the
 *     gas *used*.
 *  2. Anvil only enforces the cap with `--enable-tx-gas-limit`, and if no gas limit
 *     is supplied it auto-estimates one — happily exceeding the cap and reporting
 *     a successful execution for a transaction mainnet would reject.
 *
 * So we ask the node for the minimum viable limit up front (`eth_estimateGas` does
 * exactly the binary search needed) and compare that against the cap.
 */

import type { ethers } from "ethers";
import type { Logger } from "./types";
import { EIP7825_TX_GAS_CAP, MAX_MAINNET_TX_GAS, TX_GAS_LIMIT_BUFFER } from "./constants";

export interface GasTxRequest {
    from: string;
    to: string;
    data: string;
    value?: string;
}

export interface GasCapCheck {
    /** Minimum gas limit for which the transaction succeeds, per eth_estimateGas */
    requiredGas?: bigint;
    /** Required gas exceeds the EIP-7825 per-transaction cap */
    exceedsCap: boolean;
    /** Required gas exceeds the (cap - buffer) limit we simulate with */
    exceedsSimulationLimit: boolean;
    /** Human-readable explanation, set when a limit is exceeded */
    message?: string;
    /**
     * eth_estimateGas could not determine a viable limit.
     *
     * Backends that enforce the cap (Tenderly virtual testnets, or Anvil with
     * `--enable-tx-gas-limit`) cannot report a requirement above it: the search finds
     * no working limit and surfaces a revert instead of a number. So this is exactly
     * what an over-cap proposal looks like on an enforcing backend - though it is also
     * what a genuinely reverting proposal looks like, hence `estimateFailureReason`.
     */
    estimateFailed: boolean;
    /** Error text from the failed estimate, for disambiguating the two cases above */
    estimateFailureReason?: string;
}

/** Format a gas amount as a hex quantity for eth_sendTransaction */
export function toGasHex(gas: number): string {
    return "0x" + gas.toString(16);
}

/**
 * Determine the minimum viable gas limit for a transaction and compare it against
 * the EIP-7825 cap. Logs the findings; never throws.
 */
export async function checkTxGasCap(
    provider: ethers.JsonRpcProvider,
    tx: GasTxRequest,
    logger: Logger
): Promise<GasCapCheck> {
    let requiredGas: bigint;
    try {
        const estimate = await provider.send("eth_estimateGas", [tx]);
        requiredGas = BigInt(estimate);
    } catch (error) {
        // Either the transaction genuinely reverts at any gas limit, or the backend
        // enforces the cap and no limit within it works. We cannot tell which from here,
        // so report both possibilities rather than a bare failure.
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn(`Could not estimate gas: ${reason}`);
        return {
            exceedsCap: false,
            exceedsSimulationLimit: false,
            estimateFailed: true,
            estimateFailureReason: reason,
        };
    }

    const exceedsCap = requiredGas > BigInt(EIP7825_TX_GAS_CAP);
    const exceedsSimulationLimit = requiredGas > BigInt(MAX_MAINNET_TX_GAS);

    logger.info("Required gas limit", requiredGas);
    logger.info("EIP-7825 cap", EIP7825_TX_GAS_CAP);

    let message: string | undefined;
    if (exceedsCap) {
        const over = requiredGas - BigInt(EIP7825_TX_GAS_CAP);
        message =
            `Required gas limit ${requiredGas.toLocaleString()} exceeds the EIP-7825 ` +
            `per-transaction cap of ${EIP7825_TX_GAS_CAP.toLocaleString()} by ${over.toLocaleString()}. ` +
            `This transaction cannot be executed on mainnet.`;
        logger.error(message);
    } else if (exceedsSimulationLimit) {
        const headroom = BigInt(EIP7825_TX_GAS_CAP) - requiredGas;
        message =
            `Required gas limit ${requiredGas.toLocaleString()} is within the EIP-7825 cap ` +
            `but only by ${headroom.toLocaleString()} gas, less than the ` +
            `${TX_GAS_LIMIT_BUFFER.toLocaleString()} safety buffer. Execution is dangerously ` +
            `close to being impossible on mainnet.`;
        logger.warn(message);
    }

    return { requiredGas, exceedsCap, exceedsSimulationLimit, message, estimateFailed: false };
}

/**
 * Explain why an execution failed, for the `revertReason` field.
 *
 * An out-of-gas failure carries no revert data, so without this the operator sees a
 * FAILED status with no reason at all. Returns undefined when the gas check has nothing
 * to say, leaving the caller to fall back to the on-chain revert reason.
 */
export function describeGasFailure(check: GasCapCheck, gasLimitUsed: number): string | undefined {
    if (check.message) return check.message;

    if (check.estimateFailed) {
        return (
            `Execution failed at a gas limit of ${gasLimitUsed.toLocaleString()} ` +
            `(EIP-7825 cap ${EIP7825_TX_GAS_CAP.toLocaleString()} minus a ` +
            `${TX_GAS_LIMIT_BUFFER.toLocaleString()} buffer), and eth_estimateGas could not ` +
            `determine a viable limit. Either the proposal reverts regardless of gas, or it ` +
            `needs more than the cap allows - backends that enforce the cap cannot tell these ` +
            `apart. Re-run with the Anvil backend and the cap check disabled to measure the ` +
            `exact requirement. Estimate error: ${check.estimateFailureReason ?? "unknown"}`
        );
    }

    return undefined;
}
