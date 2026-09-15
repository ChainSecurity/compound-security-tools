import { Interface, JsonRpcProvider } from "ethers";
import { checksum } from "@/utils";
import { getProviderFor } from "@/ethers";
import { insight, selectorOfSig, type Handler, type InsightRequest } from "@/registry";
import { logger } from "@/logger";
import { getCometContractLabel } from "@/lib/comet-metadata";
import { getCometConfigDrift } from "@/lib/comet-config-drift";
import { getCometImplVersion } from "@/lib/comet-impl-version";
import { getChainByChainId } from "@/config";
import { handlerSource } from "@/types/sources";
import { stagedExtensionDelegate, stagedFactory, stagedFactoryVersion } from "@/lib/proposal-siblings";

const HANDLER_NAME = "comet-proxy-admin-handler";

const DEPLOY_AND_UPGRADE_TO_SIG = "deployAndUpgradeTo(address,address)";
const DEPLOY_UPGRADE_TO_AND_CALL_SIG = "deployUpgradeToAndCall(address,address,bytes)";

const PROXY_ADMIN_SELECTORS = new Map<string, string>([
  [selectorOfSig(DEPLOY_AND_UPGRADE_TO_SIG), DEPLOY_AND_UPGRADE_TO_SIG],
  [selectorOfSig(DEPLOY_UPGRADE_TO_AND_CALL_SIG), DEPLOY_UPGRADE_TO_AND_CALL_SIG],
]);

/** EIP-1967 admin slot: keccak256("eip1967.proxy.admin") - 1 */
const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

/**
 * Addresses confirmed on-chain to be the admin of the proxies they are asked to
 * upgrade. Consulted by the address-verification handler so that a legitimate
 * CometProxyAdmin (which is not listed in roots.json) does not raise a warning.
 */
const verifiedProxyAdmins = new Set<string>();

export function isVerifiedProxyAdmin(chainId: number, address: string): boolean {
  return verifiedProxyAdmins.has(`${chainId}:${checksum(address)}`);
}

async function readAdminSlot(
  provider: JsonRpcProvider,
  proxy: string
): Promise<string | null> {
  try {
    const raw = await provider.getStorage(proxy, EIP1967_ADMIN_SLOT);
    const admin = checksum(`0x${raw.slice(-40)}`);
    return admin === checksum("0x".padEnd(42, "0")) ? null : admin;
  } catch (err) {
    logger.debug({ proxy, err }, "Failed to read EIP-1967 admin slot");
    return null;
  }
}

async function readOwner(
  provider: JsonRpcProvider,
  proxyAdmin: string
): Promise<string | null> {
  try {
    const iface = new Interface(["function owner() view returns (address)"]);
    const raw = await provider.call({
      to: proxyAdmin,
      data: iface.encodeFunctionData("owner", []),
    });
    return checksum(iface.decodeFunctionResult("owner", raw)[0] as string);
  } catch (err) {
    logger.debug({ proxyAdmin, err }, "Failed to read proxy admin owner()");
    return null;
  }
}

function describe(chainId: number, address: string, hint?: string): string {
  const label = getCometContractLabel(chainId, address, hint);
  return label ? `${address} (${label})` : address;
}

/**
 * Comet Proxy Admin Handler
 *
 * `deployAndUpgradeTo` redeploys a Comet implementation from the Configurator's
 * stored configuration and points the Comet proxy at it. Whether that call is
 * safe depends on three on-chain facts that roots.json cannot answer:
 *   1. the target really is the admin of the Comet proxy it upgrades,
 *   2. the target really is the admin of the Configurator proxy it reads, and
 *   3. the target is owned by governance (the Timelock).
 * This handler checks all three and reports the result.
 */
export const cometProxyAdminHandler: Handler = {
  name: "Comet Proxy Admin Verification",
  match: (ctx) => {
    const selector = ctx.rawCalldata.slice(0, 10).toLowerCase();
    return PROXY_ADMIN_SELECTORS.has(selector);
  },
  expand: async (ctx) => {
    const insights: InsightRequest[] = [];
    const selector = ctx.rawCalldata.slice(0, 10).toLowerCase();
    const sig = PROXY_ADMIN_SELECTORS.get(selector);
    if (!sig) return insights;

    let configuratorProxy: string;
    let cometProxy: string;
    try {
      const iface = new Interface([`function ${sig}`]);
      const args = iface.decodeFunctionData(sig.slice(0, sig.indexOf("(")), ctx.rawCalldata);
      configuratorProxy = checksum(args[0] as string);
      cometProxy = checksum(args[1] as string);
    } catch (err) {
      logger.debug({ err }, "Proxy admin verification skipped: undecodable calldata");
      return insights;
    }

    const proxyAdmin = checksum(ctx.target);
    let provider: JsonRpcProvider;
    try {
      provider = getProviderFor(ctx.chainId);
    } catch (err) {
      logger.debug({ chainId: ctx.chainId, err }, "Proxy admin verification skipped: missing provider");
      insights.push(
        insight({
          title: "Comet Upgrade (No RPC)",
          entries: [
            { label: "ProxyAdmin", value: proxyAdmin },
            { label: "Comet", value: describe(ctx.chainId, cometProxy) },
            { label: "Status", value: "Configure RPC to verify proxy admin authority" },
          ],
          _handlerSource: handlerSource(HANDLER_NAME),
        })
      );
      return insights;
    }

    const [cometAdmin, configuratorAdmin, owner, drift, implVersion] = await Promise.all([
      readAdminSlot(provider, cometProxy),
      readAdminSlot(provider, configuratorProxy),
      readOwner(provider, proxyAdmin),
      getCometConfigDrift(provider, configuratorProxy, cometProxy),
      getCometImplVersion(provider, ctx.chainId, configuratorProxy, cometProxy),
    ]);

    const cometAdminOk = cometAdmin !== null && cometAdmin === proxyAdmin;
    const configuratorAdminOk = configuratorAdmin !== null && configuratorAdmin === proxyAdmin;

    const configuredTimelock = getChainByChainId(ctx.chainId)?.timelockAddress;
    const timelock = configuredTimelock ? checksum(configuredTimelock) : null;
    const ownerOk = owner !== null && timelock !== null && owner === timelock;

    if (cometAdminOk && configuratorAdminOk) {
      verifiedProxyAdmins.add(`${ctx.chainId}:${proxyAdmin}`);
    }

    const mark = (ok: boolean) => (ok ? "✓" : "⚠️");

    // What the redeploy carries beyond this proposal's own setters. Read from
    // current chain state, so setter calls in this same proposal are not yet
    // reflected here — anything listed was staged by an *earlier* transaction.
    const driftEntries: Array<{ label: string; value: string }> = [];
    if (drift.error) {
      driftEntries.push({ label: "⚠️ Staged config changes", value: drift.error });
    } else if (drift.changes.length === 0) {
      driftEntries.push({
        label: "✓ Staged config changes",
        value:
          "none — the Configurator's parameters already match the live implementation, so no parameter change rides along with this upgrade",
      });
    } else {
      driftEntries.push({
        label: `⚠️ Staged config changes (${drift.changes.length})`,
        value:
          "already in the Configurator before this proposal; this upgrade applies them too",
      });
      for (const change of drift.changes) {
        driftEntries.push({ label: "  •", value: change });
      }
    }

    // The factory decides the *code* the redeploy produces; the drift diff above
    // only covers parameters. A market whose live implementation is a different
    // size from its same-factory siblings is running different code, which is
    // precisely what a redeploy after a factory version bump is meant to fix.
    // `deployAndUpgradeTo` reads the Configurator at execution time, so an earlier
    // action in this same proposal can redirect it to a different factory (and
    // hence different code) than the one live state reports. When that happens the
    // sibling-blind comparison below is about the wrong factory and must not be
    // printed — it would read as "this upgrade is a no-op".
    const pendingFactory = stagedFactory(ctx.siblings, ctx.chainId, cometProxy);
    const pendingExt = stagedExtensionDelegate(ctx.siblings, ctx.chainId, cometProxy);

    const factoryEntries: Array<{ label: string; value: string }> = [];
    if (pendingFactory) {
      const pendingVersion = stagedFactoryVersion(
        ctx.siblings,
        ctx.chainId,
        pendingFactory.value
      );
      factoryEntries.push({
        label: "Factory at execution",
        value:
          `${describe(ctx.chainId, pendingFactory.value)} — set by action #${pendingFactory.actionIndex} ` +
          `of this proposal, replacing ${
            implVersion.factory ? describe(ctx.chainId, implVersion.factory) : "the current factory"
          }`,
      });
      if (pendingVersion) {
        factoryEntries.push({
          label: "Factory version at execution",
          value:
            `${pendingVersion.value} — set by action #${pendingVersion.actionIndex} of this proposal. ` +
            "The implementation is resolved from the bytecode repository at execution time, so " +
            "this version decides the code deployed; it is not knowable from the calldata alone.",
        });
      }
      if (pendingExt) {
        factoryEntries.push({
          label: "Extension delegate at execution",
          value: `${describe(ctx.chainId, pendingExt.value)} — set by action #${pendingExt.actionIndex} of this proposal`,
        });
      }
      if (implVersion.liveImpl && implVersion.liveCodeSize !== undefined) {
        factoryEntries.push({
          label: "Implementation being replaced",
          value: `${implVersion.liveImpl} (${implVersion.liveCodeSize} bytes of code)`,
        });
      }
      factoryEntries.push({
        label: "⚠️ Implementation code",
        value:
          "changes — the market is being moved to a different factory by this proposal, so the " +
          "redeploy replaces the implementation bytecode, not just its parameters. Verify the " +
          "target version in the bytecode repository (init code hash + audit) before approving.",
      });
    } else if (implVersion.error) {
      factoryEntries.push({ label: "⚠️ Factory", value: implVersion.error });
    } else if (implVersion.factory) {
      factoryEntries.push({
        label: "Factory",
        value: implVersion.factoryVersion
          ? `${describe(ctx.chainId, implVersion.factory)} — version ${implVersion.factoryVersion}`
          : describe(ctx.chainId, implVersion.factory),
      });
      if (pendingExt) {
        factoryEntries.push({
          label: "Extension delegate at execution",
          value: `${describe(ctx.chainId, pendingExt.value)} — set by action #${pendingExt.actionIndex} of this proposal`,
        });
      }
      if (implVersion.liveImpl && implVersion.liveCodeSize !== undefined) {
        factoryEntries.push({
          label: "Live implementation",
          value: `${implVersion.liveImpl} (${implVersion.liveCodeSize} bytes of code)`,
        });
      }
      const peers = `${implVersion.peerAgreeing} of ${implVersion.peerCount} sibling market(s) built by this same factory`;
      if (implVersion.differsFromPeers === true) {
        factoryEntries.push({
          label: "⚠️ Implementation code",
          value:
            `${implVersion.peerCodeSize} bytes across ${peers} — this market is on different code, ` +
            `so the redeploy changes the implementation bytecode, not just its parameters`,
        });
      } else if (implVersion.differsFromPeers === false) {
        factoryEntries.push({
          label: "✓ Implementation code",
          value: `same size as ${peers} — already on the code this factory currently produces`,
        });
      }
    }

    insights.push(
      insight({
        title: "Comet Implementation Redeploy & Upgrade",
        entries: [
          { label: "Comet", value: describe(ctx.chainId, cometProxy) },
          {
            label: "Configurator",
            value: describe(ctx.chainId, configuratorProxy, cometProxy),
          },
          {
            label: `${mark(cometAdminOk)} Admin of Comet proxy`,
            value: cometAdmin
              ? `${cometAdmin}${cometAdminOk ? " — matches target" : ` — target is ${proxyAdmin}`}`
              : "could not read EIP-1967 admin slot",
          },
          {
            label: `${mark(configuratorAdminOk)} Admin of Configurator proxy`,
            value: configuratorAdmin
              ? `${configuratorAdmin}${configuratorAdminOk ? " — matches target" : ` — target is ${proxyAdmin}`}`
              : "could not read EIP-1967 admin slot",
          },
          {
            label: `${mark(ownerOk)} ProxyAdmin owner`,
            value: owner
              ? `${owner}${ownerOk ? " (Timelock)" : " — NOT the configured Timelock"}`
              : "could not read owner()",
          },
          ...driftEntries,
          ...factoryEntries,
          {
            label: "Effect",
            value:
              "Deploys a new Comet implementation from the Configurator's stored config and upgrades the proxy. Existing market state is preserved (upgrade only, no re-initialization).",
          },
        ],
        _handlerSource: handlerSource(
          HANDLER_NAME,
          "EIP-1967 admin slot of both proxies + owner() of the ProxyAdmin, Configurator.getConfiguration() vs the live Comet's parameters, and Configurator.factory() plus the live implementation's code size against sibling markets, all read on-chain"
        ),
      })
    );

    return insights;
  },
};
