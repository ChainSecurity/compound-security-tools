import { AbiCoder } from "ethers";
import { checksum } from "@/utils";
import { child, selectorOfSig, type Handler, type RegistryCtx } from "@/registry";

/**
 * Linea Bridge Receiver (fallback) handler
 *
 * The receiver fallback is invoked by the Linea Message Service and forwards:
 *   abi.encode(address[], uint256[], string[], bytes[])
 * representing a queued proposal's batched actions on Linea.
 *
 * We expand this into N children (multicall), one per (target, value, signature, calldata).
 */

const LINEA_CHAIN_ID = 59144;

const KNOWN_RECEIVERS = new Set<string>([checksum("0x1F71901daf98d70B4BAF40DE080321e5C2676856")]);

const coder = AbiCoder.defaultAbiCoder();

function tryDecodeTuple(data: string) {
  try {
    const [targets, values, signatures, calldatas] = coder.decode(
      ["address[]", "uint256[]", "string[]", "bytes[]"],
      data
    ) as unknown as [string[], bigint[], string[], string[]];

    if (
      Array.isArray(targets) &&
      Array.isArray(values) &&
      Array.isArray(signatures) &&
      Array.isArray(calldatas) &&
      targets.length === values.length &&
      targets.length === signatures.length &&
      targets.length === calldatas.length
    ) {
      return { targets, values, signatures, calldatas };
    }
  } catch {
    // not decodable in this shape
  }
  return null;
}

export const lineaBridgeReceiverHandler: Handler = {
  name: "Linea Bridge Receiver (fallback multicall)",
  match: (ctx: RegistryCtx) => {
    return KNOWN_RECEIVERS.has(checksum(ctx.target));
  },

  expand: (ctx: RegistryCtx) => {
    const decoded = tryDecodeTuple(ctx.rawCalldata);
    if (!decoded) return [];

    const { targets, values, signatures, calldatas } = decoded;
    const children = [];

    for (let i = 0; i < targets.length; i++) {
      const target = checksum(targets[i]!);
      const valueWei = values[i] ?? 0n;
      const signature = signatures[i] ?? "";
      const calldata = calldatas[i] ?? "0x";

      // If signature is provided, prefix its 4-byte selector to the args bytes.
      // If not, pass through the calldata as-is (may be a raw payload / fallback).
      const rawCalldata =
        signature && signature.length > 0
          ? selectorOfSig(signature) + (calldata.startsWith("0x") ? calldata.slice(2) : calldata)
          : calldata;

      children.push(
        child(
          {
            type: "multicall",
            label: "Linea Bridge Receiver",
            chainId: LINEA_CHAIN_ID,
            meta: { index: i },
          },
          {
            chainId: LINEA_CHAIN_ID,
            target,
            valueWei,
            rawCalldata,
            sigHint: signature && signature.length > 0 ? signature : undefined,
          }
        )
      );
    }

    return children;
  },
};
