import { Interface, JsonRpcProvider } from "ethers";
import { checksum } from "@/utils";
import { getProviderFor } from "@/ethers";
import { insight, selectorOfSig, type Handler, type InsightRequest } from "@/registry";
import { logger } from "@/logger";
import { getCometContractLabel } from "@/lib/comet-metadata";
import { handlerSource } from "@/types/sources";
import { stagedFactoryVersion } from "@/lib/proposal-siblings";

/**
 * `Configurator.setExtensionDelegate(comet, ext)` and `Configurator.setFactory(comet, factory)`
 * decode to nothing but two addresses, yet they decide, respectively, which contract
 * serves every `delegatecall` fallback on the market and which contract builds its next
 * implementation. Neither address is in roots.json for a fresh deployment, so a reviewer
 * reading the decode has no way to tell a correct delegate from one belonging to a
 * different market.
 *
 * The failure mode this handler exists to catch is a *swapped* delegate: `name()` and
 * `symbol()` are baked into the extension delegate, so pointing cWETHv3 at cUSDCv3's
 * delegate silently renames the market while every other check still passes. The handler
 * compares the incoming delegate's name/symbol against the target Comet's own and warns
 * on any mismatch.
 *
 * It also records that neither setter takes effect on its own: both write to the
 * Configurator's stored config, and the live market only changes once
 * `CometProxyAdmin.deployAndUpgradeTo` redeploys it.
 */
const HANDLER_NAME = "comet-extension-delegate-handler";

const SET_EXTENSION_DELEGATE_SIG = "setExtensionDelegate(address,address)";
const SET_FACTORY_SIG = "setFactory(address,address)";

const SELECTORS = new Map<string, string>([
  [selectorOfSig(SET_EXTENSION_DELEGATE_SIG), SET_EXTENSION_DELEGATE_SIG],
  [selectorOfSig(SET_FACTORY_SIG), SET_FACTORY_SIG],
]);

const COMET_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function extensionDelegate() view returns (address)",
];

const CONFIGURATOR_ABI = ["function factory(address) view returns (address)"];

const FACTORY_ABI = ["function version() view returns ((uint64,uint64,uint64),string)"];

async function read<T>(
  provider: JsonRpcProvider,
  address: string,
  iface: Interface,
  fn: string,
  args: unknown[] = []
): Promise<T | null> {
  try {
    const raw = await provider.call({ to: address, data: iface.encodeFunctionData(fn, args) });
    const decoded = iface.decodeFunctionResult(fn, raw);
    return (decoded.length === 1 ? decoded[0] : decoded) as T;
  } catch (err) {
    logger.debug({ address, fn, err }, "Comet extension delegate: call failed");
    return null;
  }
}

async function codeSize(provider: JsonRpcProvider, address: string): Promise<number | null> {
  try {
    const code = await provider.getCode(address);
    return (code.length - 2) / 2;
  } catch (err) {
    logger.debug({ address, err }, "Comet extension delegate: getCode failed");
    return null;
  }
}

function describe(chainId: number, address: string, hint?: string): string {
  const label = getCometContractLabel(chainId, address, hint);
  return label ? `${address} (${label})` : address;
}

export const cometExtensionDelegateHandler: Handler = {
  name: "Comet Extension Delegate / Factory Verification",
  match: (ctx) => SELECTORS.has(ctx.rawCalldata.slice(0, 10).toLowerCase()),
  expand: async (ctx) => {
    const insights: InsightRequest[] = [];
    const sig = SELECTORS.get(ctx.rawCalldata.slice(0, 10).toLowerCase());
    if (!sig) return insights;

    const isDelegate = sig === SET_EXTENSION_DELEGATE_SIG;

    let cometProxy: string;
    let newAddress: string;
    try {
      const iface = new Interface([`function ${sig}`]);
      const args = iface.decodeFunctionData(sig.slice(0, sig.indexOf("(")), ctx.rawCalldata);
      cometProxy = checksum(args[0] as string);
      newAddress = checksum(args[1] as string);
    } catch (err) {
      logger.debug({ err }, "Comet extension delegate skipped: undecodable calldata");
      return insights;
    }

    const title = isDelegate
      ? "Comet Extension Delegate Change"
      : "Comet Factory Change";

    let provider: JsonRpcProvider;
    try {
      provider = getProviderFor(ctx.chainId);
    } catch (err) {
      logger.debug({ chainId: ctx.chainId, err }, "Comet extension delegate skipped: missing provider");
      insights.push(
        insight({
          title: `${title} (No RPC)`,
          entries: [
            { label: "Comet", value: describe(ctx.chainId, cometProxy) },
            { label: isDelegate ? "New extension delegate" : "New factory", value: newAddress },
            {
              label: "Status",
              value: "Configure an RPC to verify the new address has code and belongs to this market",
            },
          ],
          _handlerSource: handlerSource(HANDLER_NAME),
        })
      );
      return insights;
    }

    const cometIface = new Interface(COMET_ABI);
    const entries: Array<{ label: string; value: string }> = [
      { label: "Comet", value: describe(ctx.chainId, cometProxy) },
    ];

    const [newCodeSize, cometName, cometSymbol] = await Promise.all([
      codeSize(provider, newAddress),
      read<string>(provider, cometProxy, cometIface, "name"),
      read<string>(provider, cometProxy, cometIface, "symbol"),
    ]);

    if (isDelegate) {
      const [current, extName, extSymbol] = await Promise.all([
        read<string>(provider, cometProxy, cometIface, "extensionDelegate"),
        read<string>(provider, newAddress, cometIface, "name"),
        read<string>(provider, newAddress, cometIface, "symbol"),
      ]);

      entries.push({
        label: "Current extension delegate",
        value: current ? describe(ctx.chainId, checksum(current)) : "could not read extensionDelegate()",
      });
      entries.push({
        label: "New extension delegate",
        value: describe(ctx.chainId, newAddress),
      });

      if (current && checksum(current) === newAddress) {
        entries.push({
          label: "⚠️ No-op",
          value: "the market already uses this extension delegate",
        });
      }

      if (newCodeSize === 0) {
        entries.push({
          label: "⚠️ New delegate has NO CODE",
          value:
            "every fallback call on the market delegatecalls into this address; an EOA or " +
            "undeployed address bricks balanceOf/allowance/collateralBalanceOf on the market",
        });
      } else if (newCodeSize !== null) {
        entries.push({ label: "✓ New delegate code", value: `${newCodeSize} bytes` });
      }

      // name()/symbol() are constructor arguments of the extension delegate, so a delegate
      // built for another market silently renames this one while every other check passes.
      if (extName !== null && extSymbol !== null && cometName !== null && cometSymbol !== null) {
        const matches = extName === cometName && extSymbol === cometSymbol;
        entries.push({
          label: matches ? "✓ Delegate identity" : "⚠️ DELEGATE IDENTITY MISMATCH",
          value: matches
            ? `name()/symbol() = "${extName}" / "${extSymbol}" — same as the market it is being set on`
            : `delegate reports "${extName}" / "${extSymbol}" but the market is "${cometName}" / "${cometSymbol}" — ` +
              "this delegate was almost certainly built for a different market and would rename this one",
        });
      } else if (extName === null || extSymbol === null) {
        entries.push({
          label: "⚠️ Delegate identity",
          value:
            "could not read name()/symbol() on the new delegate — it may not be a CometExt contract",
        });
      }
    } else {
      const [current, newVersion] = await Promise.all([
        read<string>(provider, ctx.target, new Interface(CONFIGURATOR_ABI), "factory", [cometProxy]),
        read<[[bigint, bigint, bigint], string]>(
          provider,
          newAddress,
          new Interface(FACTORY_ABI),
          "version"
        ),
      ]);

      entries.push({
        label: "Current factory",
        value: current ? describe(ctx.chainId, checksum(current)) : "could not read Configurator.factory()",
      });
      entries.push({ label: "New factory", value: describe(ctx.chainId, newAddress) });

      if (current && checksum(current) === newAddress) {
        entries.push({
          label: "⚠️ No-op",
          value: "the Configurator already points this market at that factory",
        });
      }

      if (newCodeSize === 0) {
        entries.push({
          label: "⚠️ New factory has NO CODE",
          value: "the next deployAndUpgradeTo for this market would revert",
        });
      } else if (newCodeSize !== null) {
        entries.push({ label: "✓ New factory code", value: `${newCodeSize} bytes` });
      }

      // A versioned factory resolves its bytecode at execution time, so the
      // version that matters is the one in effect when the redeploy runs — which
      // an earlier action in this same proposal may already have changed.
      const staged = stagedFactoryVersion(ctx.siblings, ctx.chainId, newAddress);
      const liveVersion = newVersion
        ? `${newVersion[0][0]}.${newVersion[0][1]}.${newVersion[0][2]}${newVersion[1] ?? ""}`
        : null;

      if (staged) {
        entries.push({
          label: "New factory version",
          value:
            `${staged.value} at execution — set by action #${staged.actionIndex} of this proposal` +
            (liveVersion && liveVersion !== staged.value
              ? ` (currently ${liveVersion} on-chain)`
              : "") +
            ". A versioned factory resolves its bytecode from a repository at execution time, " +
            "so this is the version that decides the code the redeploy deploys.",
        });
      } else if (liveVersion) {
        entries.push({
          label: "New factory version",
          value:
            `${liveVersion} ` +
            "— a versioned factory resolves its bytecode from a repository at execution time, " +
            "so the version set on the factory when the redeploy runs decides the code deployed",
        });
      }
    }

    entries.push({
      label: "Effect",
      value:
        "Writes to the Configurator's stored configuration only. The live market is unchanged " +
        "until CometProxyAdmin.deployAndUpgradeTo redeploys it — a proposal that sets this " +
        "without a matching redeploy leaves the change staged and silently applies it to whichever " +
        "later proposal redeploys the market.",
    });

    insights.push(
      insight({
        title,
        entries,
        _handlerSource: handlerSource(
          HANDLER_NAME,
          isDelegate
            ? "Comet.extensionDelegate()/name()/symbol() and the new delegate's own name()/symbol() and code size, read on-chain"
            : "Configurator.factory(comet) and the new factory's code size and version(), read on-chain"
        ),
      })
    );

    return insights;
  },
};
