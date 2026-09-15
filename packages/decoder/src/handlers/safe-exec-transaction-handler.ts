import { Interface } from "ethers";
import { checksum } from "@/utils";
import { child, selectorOfSig, type Handler, type RegistryCtx } from "@/registry";

/**
 * Safe (Gnosis Safe) `execTransaction`. Governance payloads that drive a Safe wrap the call
 * they actually want to make inside `data`, so the interesting part is invisible without
 * expanding it. We recurse into `data` and flag the two fields that change the security
 * meaning of the call: `operation` (a DELEGATECALL runs foreign code in the Safe's own
 * storage) and the signature blob, which for a governance-owned Safe is normally a
 * pre-validated owner signature rather than a real ECDSA one.
 */

const SIG =
  "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)";
const SELECTOR = selectorOfSig(SIG);

const iface = new Interface([
  `function ${SIG} payable returns (bool)`,
]);

/**
 * Safe signature encoding: 65-byte words, where v == 0 means a contract signature, v == 1
 * means "pre-validated" (valid if the owner is msg.sender or pre-approved the hash), and
 * v >= 27 is a normal ECDSA signature. A pre-validated word carries the owner in `r`.
 */
function describeSignatures(sigs: string): string {
  const bytes = (sigs.length - 2) / 2;
  if (bytes === 0) return "empty (threshold must be 0 — unusual)";
  if (bytes % 65 !== 0) return `${bytes} bytes (contains dynamic/contract signatures)`;
  const words = bytes / 65;
  const parts: string[] = [];
  for (let i = 0; i < words; i++) {
    const word = sigs.slice(2 + i * 130, 2 + (i + 1) * 130);
    const v = parseInt(word.slice(128, 130), 16);
    if (v === 1) {
      parts.push(`pre-validated by ${checksum(`0x${word.slice(24, 64)}`)}`);
    } else if (v === 0) {
      parts.push(`contract signature from ${checksum(`0x${word.slice(24, 64)}`)}`);
    } else {
      parts.push("ECDSA");
    }
  }
  return `${words} signer word(s): ${parts.join(", ")}`;
}

export const safeExecTransactionHandler: Handler = {
  name: "Safe execTransaction",
  match: (ctx: RegistryCtx) => (ctx.rawCalldata?.slice(0, 10) ?? "") === SELECTOR,

  expand: (ctx: RegistryCtx) => {
    let parsed;
    try {
      parsed = iface.parseTransaction({ data: ctx.rawCalldata });
    } catch {
      return [];
    }
    if (!parsed) return [];

    const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures] =
      parsed.args.toArray() as [
        string, bigint, string, bigint, bigint, bigint, bigint, string, string, string
      ];

    const isDelegateCall = BigInt(operation) === 1n;

    const entries = [
      { label: "Operation", value: isDelegateCall ? "1 — DELEGATECALL ⚠️" : "0 — CALL" },
      { label: "Signatures", value: describeSignatures(signatures) },
      {
        label: "Gas / refund",
        value:
          `safeTxGas=${safeTxGas} baseGas=${baseGas} gasPrice=${gasPrice}` +
          (BigInt(gasPrice) === 0n
            ? " (no refund; the inner call must succeed or the whole tx reverts with GS013)"
            : ` gasToken=${checksum(gasToken)} refundReceiver=${checksum(refundReceiver)}`),
      },
    ];

    return {
      children: [
        child(
          {
            type: isDelegateCall ? ("delegatecall" as const) : ("call" as const),
            chainId: ctx.chainId,
            label: `Safe.execTransaction (${checksum(ctx.target)})`,
            meta: { operation: Number(operation) },
          },
          {
            chainId: ctx.chainId,
            target: checksum(to),
            rawCalldata: data,
            valueWei: BigInt(value),
          }
        ),
      ],
      insights: [{ kind: "insight" as const, insight: { title: "🔐 Safe Transaction", entries } }],
    };
  },
};
