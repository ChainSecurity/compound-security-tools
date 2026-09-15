import { insight, type InsightRequest } from "@/registry";
import { handlerSource } from "@/types/sources";

/**
 * Estimates the gas needed to *queue* a bridged Compound proposal on an L2, and
 * compares it against the gas the bridge will actually forward.
 *
 * This is worth checking because the two bridges fail very differently:
 *
 *  - Polygon FxPortal: StateReceiver (0x…1001) invokes `onStateReceive` with a
 *    hardcoded 5,000,000 gas cap via a low-level call whose result is ignored.
 *    An out-of-gas relay is NOT replayable — the state sync is consumed and the
 *    message is lost permanently.
 *  - OP Stack: the target gets roughly `_minGasLimit`. An out-of-gas relay marks
 *    the message in `failedMessages` and anyone can replay it with more gas.
 *
 * Cost is dominated by `BaseBridgeReceiver.processMessage`, which writes the whole
 * proposal (targets, values, signature strings, calldata bytes) into storage before
 * queueing each action — so it scales with payload size, not action count.
 *
 * The slope/intercept below are fitted to two measured points taken against forked
 * mainnet state (Polygon: 7,808 B => ~4.79M gas; Unichain: 5,696 B => ~3.42M gas).
 * It is a heuristic, not a substitute for simulating the relay.
 */

const GAS_PER_PAYLOAD_BYTE = 649;
const GAS_INTERCEPT = -275_000;

/** Hardcoded gas cap in Polygon's StateReceiver.commitState (PUSH3 0x4c4b40). */
export const POLYGON_STATE_SYNC_GAS_CAP = 5_000_000;

/** Below this fraction of headroom we flag the margin as thin. */
const THIN_MARGIN = 0.2;

export function estimateRelayGas(payloadBytes: number): number {
  return Math.max(0, Math.round(GAS_PER_PAYLOAD_BYTE * payloadBytes + GAS_INTERCEPT));
}

export function buildRelayGasInsight(opts: {
  payload: string;
  gasLimit: number;
  bridgeLabel: string;
  /** OP Stack relays can be replayed permissionlessly; Polygon FxPortal relays cannot. */
  replayable: boolean;
  /** How the cap arises, e.g. "_minGasLimit argument" or "StateReceiver hardcoded cap". */
  limitSource: string;
}): InsightRequest | null {
  const payloadBytes = Math.max(0, (opts.payload.replace(/^0x/, "").length / 2) | 0);
  if (payloadBytes === 0) return null;

  const estimate = estimateRelayGas(payloadBytes);
  const headroom = opts.gasLimit - estimate;
  const headroomPct = opts.gasLimit > 0 ? headroom / opts.gasLimit : 0;

  const insufficient = headroom <= 0;
  const thin = !insufficient && headroomPct < THIN_MARGIN;

  const title = insufficient
    ? "⚠️ Bridge Relay Gas — LIKELY INSUFFICIENT"
    : thin
      ? "⚠️ Bridge Relay Gas — Thin Margin"
      : "Bridge Relay Gas";

  const consequence = opts.replayable
    ? "Relay would revert out-of-gas; message lands in failedMessages and needs a manual (permissionless) replay with more gas."
    : "Relay would revert out-of-gas; FxPortal ignores the failure and the message is LOST PERMANENTLY (no replay).";

  const entries = [
    { label: "Bridge", value: opts.bridgeLabel },
    { label: "Payload", value: `${payloadBytes.toLocaleString()} bytes` },
    { label: "Gas forwarded", value: `${opts.gasLimit.toLocaleString()} (${opts.limitSource})` },
    { label: "Est. gas to queue", value: `~${estimate.toLocaleString()} (heuristic)` },
    {
      label: "Headroom",
      value: `${headroom.toLocaleString()} (${(headroomPct * 100).toFixed(1)}%)`,
    },
    { label: "Replayable", value: opts.replayable ? "yes" : "NO — failure is permanent" },
  ];

  if (insufficient || thin) entries.push({ label: "Impact", value: consequence });
  entries.push({ label: "Confirm with", value: "pnpm simulate <id> — estimate is a heuristic" });

  return insight({
    title,
    entries,
    _handlerSource: handlerSource("bridge-relay-gas"),
  });
}
