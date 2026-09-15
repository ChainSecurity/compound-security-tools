import { Interface } from "ethers";
import { checksum } from "@/utils";
import { child, selectorOfSig, type Handler, type RegistryCtx } from "@/registry";
import { logger } from "@/logger";

/**
 * OpenZeppelin `TimelockController` (used by Compound for the Treasury Timelock and by
 * many satellite committees).
 *
 * A governance action against one of these contracts carries the call it will *eventually*
 * make as an opaque `bytes data` argument, so without expanding it the reviewer only sees
 * `schedule(address, uint256, bytes, bytes32, bytes32, uint256)` and has to peel the
 * payload by hand. We expand `data` into a child call executed by the timelock itself, and
 * surface the fields that decide whether the operation can ever run: the delay, the
 * `predecessor` it is chained behind, and the `salt` (frequently a human-readable tag).
 */

const SCHEDULE = "schedule(address,uint256,bytes,bytes32,bytes32,uint256)";
const EXECUTE = "execute(address,uint256,bytes,bytes32,bytes32)";
const SCHEDULE_BATCH = "scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)";
const EXECUTE_BATCH = "executeBatch(address[],uint256[],bytes[],bytes32,bytes32)";

const SELECTORS = new Set([SCHEDULE, EXECUTE, SCHEDULE_BATCH, EXECUTE_BATCH].map(selectorOfSig));

const iface = new Interface([
  `function ${SCHEDULE}`,
  `function ${EXECUTE} payable`,
  `function ${SCHEDULE_BATCH}`,
  `function ${EXECUTE_BATCH} payable`,
]);

const ZERO32 = `0x${"00".repeat(32)}`;

/** bytes32 salts are usually a left-aligned ASCII tag; render it when it is one. */
function saltAscii(salt: string): string | undefined {
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt) || salt.toLowerCase() === ZERO32) return undefined;
  const bytes = Buffer.from(salt.slice(2), "hex");
  const end = bytes.findIndex((b) => b === 0);
  const head = end === -1 ? bytes : bytes.subarray(0, end);
  if (!head.length) return undefined;
  // Everything after the first NUL must also be NUL, and the tag must be printable ASCII.
  if (bytes.subarray(head.length).some((b) => b !== 0)) return undefined;
  if (head.some((b) => b < 0x20 || b > 0x7e)) return undefined;
  return head.toString("ascii");
}

function humanDelay(seconds: bigint): string {
  const days = Number(seconds) / 86400;
  return `${seconds.toString()} s (${days} days)`;
}

export const timelockControllerHandler: Handler = {
  name: "OZ TimelockController",
  match: (ctx: RegistryCtx) => SELECTORS.has(ctx.rawCalldata?.slice(0, 10) ?? ""),

  expand: (ctx: RegistryCtx) => {
    let parsed;
    try {
      parsed = iface.parseTransaction({ data: ctx.rawCalldata });
    } catch {
      return [];
    }
    if (!parsed) return [];

    const isBatch = parsed.name === "scheduleBatch" || parsed.name === "executeBatch";
    const isSchedule = parsed.name === "schedule" || parsed.name === "scheduleBatch";

    const targets: string[] = isBatch ? [...parsed.args[0]] : [parsed.args[0]];
    const values: bigint[] = isBatch
      ? [...parsed.args[1]].map((v) => BigInt(v))
      : [BigInt(parsed.args[1])];
    const payloads: string[] = isBatch ? [...parsed.args[2]] : [parsed.args[2]];
    const predecessor: string = parsed.args[3];
    const salt: string = parsed.args[4];
    const delay: bigint | undefined = isSchedule ? BigInt(parsed.args[5]) : undefined;

    if (targets.length !== payloads.length || targets.length !== values.length) {
      logger.warn({ target: checksum(ctx.target) }, "TimelockController batch arity mismatch");
      return [];
    }

    const entries = [
      { label: "Operation", value: `${parsed.name}${isBatch ? ` (${targets.length} calls)` : ""}` },
      {
        label: "Predecessor",
        value:
          predecessor.toLowerCase() === ZERO32
            ? "none (unchained — may execute in any order)"
            : `${predecessor} (must be Done first)`,
      },
      { label: "Salt", value: saltAscii(salt) ? `${salt} — "${saltAscii(salt)}"` : salt },
    ];
    if (delay !== undefined) entries.push({ label: "Delay", value: humanDelay(delay) });

    const children = targets.map((to, i) =>
      child(
        {
          type: "call" as const,
          chainId: ctx.chainId,
          label: `TimelockController.${parsed.name}${isBatch ? `[${i}]` : ""}`,
          meta: {
            predecessor,
            salt,
            saltAscii: saltAscii(salt),
            ...(delay !== undefined ? { delaySeconds: delay.toString() } : {}),
          },
        },
        {
          chainId: ctx.chainId,
          target: checksum(to),
          rawCalldata: payloads[i]!,
          valueWei: values[i]!,
        }
      )
    );

    return {
      children,
      insights: [
        {
          kind: "insight" as const,
          insight: { title: "⏳ Timelock Operation", entries },
        },
      ],
    };
  },
};
