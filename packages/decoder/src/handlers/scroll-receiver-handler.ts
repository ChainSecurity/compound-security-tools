import { AbiCoder } from "ethers";
import { checksum } from "../utils.js";
import { child, selectorOfSig, type Handler, type RegistryCtx } from "../registry.js";

/**
 * Scroll Bridge Receiver (fallback)
 *
 * Mirrors the Linea receiver behaviour: calldata encodes
 *   abi.encode(address[], uint256[], string[], bytes[])
 * representing batched actions queued on Scroll.
 */
const SCROLL_CHAIN_ID = 534352;
const KNOWN_RECEIVERS = new Set<string>([checksum("0xC6bf5A64896D679Cf89843DbeC6c0f5d3C9b610D")]);

const coder = AbiCoder.defaultAbiCoder();

function decodeBatch(data: string) {
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
    return null;
  }
  return null;
}

export const scrollBridgeReceiverHandler: Handler = {
  name: "Scroll Bridge Receiver (fallback multicall)",
  match: (ctx: RegistryCtx) => {
    return KNOWN_RECEIVERS.has(checksum(ctx.target));
  },
  expand: (ctx: RegistryCtx) => {
    const decoded = decodeBatch(ctx.rawCalldata);
    if (!decoded) return [];

    const children = [];
    for (let i = 0; i < decoded.targets.length; i++) {
      const target = checksum(decoded.targets[i]!);
      const valueWei = decoded.values[i] ?? 0n;
      const sig = decoded.signatures[i] ?? "";
      const argsData = decoded.calldatas[i] ?? "0x";

      const rawCalldata =
        sig && sig.length > 0
          ? selectorOfSig(sig) + (argsData.startsWith("0x") ? argsData.slice(2) : argsData)
          : argsData;

      children.push(
        child(
          {
            type: "multicall",
            label: "Scroll Bridge Receiver",
            chainId: SCROLL_CHAIN_ID,
            meta: { index: i },
          },
          {
            chainId: SCROLL_CHAIN_ID,
            target,
            valueWei,
            rawCalldata,
            sigHint: sig && sig.length > 0 ? sig : undefined,
          }
        )
      );
    }

    return children;
  },
};
