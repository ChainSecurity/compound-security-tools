import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { checksum } from "@/utils";
import { insight, type Handler, type InsightRequest } from "@/registry";
import { logger } from "@/logger";
import { handlerSource, staticMetadataSource } from "@/types/sources";
import { isVerifiedProxyAdmin } from "@/handlers/comet-proxy-admin-handler";

const HANDLER_NAME = "address-verification-handler";

/**
 * Address Verification Handler
 *
 * Checks if target addresses are present in the authoritative roots.json files
 * from vendor/comet/deployments. Warns when an address is not found.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..", "..");
const MONOREPO_ROOT = join(PACKAGE_ROOT, "..", "..");
const DEPLOYMENTS_ROOT = join(MONOREPO_ROOT, "vendor", "comet", "deployments");

const CHAIN_DIRECTORY: Record<number, string> = {
  1: "mainnet",
  10: "optimism",
  8453: "base",
  42161: "arbitrum",
  59144: "linea",
  534352: "scroll",
  130: "unichain",
  137: "polygon",
  5000: "mantle",
  2020: "ronin",
};

type KnownAddress = {
  address: string;
  type: string;
  market?: string;
};

// Cache: chainId -> Set of known addresses with their types
const knownAddressesCache = new Map<number, Map<string, KnownAddress>>();

function loadKnownAddresses(chainId: number): Map<string, KnownAddress> {
  if (knownAddressesCache.has(chainId)) {
    return knownAddressesCache.get(chainId)!;
  }

  const knownAddresses = new Map<string, KnownAddress>();
  const dirName = CHAIN_DIRECTORY[chainId];

  if (!dirName) {
    knownAddressesCache.set(chainId, knownAddresses);
    return knownAddresses;
  }

  const chainPath = join(DEPLOYMENTS_ROOT, dirName);
  if (!existsSync(chainPath)) {
    knownAddressesCache.set(chainId, knownAddresses);
    return knownAddresses;
  }

  try {
    const marketDirs = readdirSync(chainPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const market of marketDirs) {
      const rootsPath = join(chainPath, market, "roots.json");
      if (!existsSync(rootsPath)) continue;

      try {
        const roots = JSON.parse(readFileSync(rootsPath, "utf8")) as Record<string, string>;

        // Map all known contract types
        const contractTypes = [
          "comet",
          "configurator",
          "rewards",
          "cometFactory",
          "bridgeReceiver",
          "bulker",
          "cometProxyAdmin",
          "l2CCIPRouter",
          "l2CCIPOffRamp",
          "l2TokenAdminRegistry",
        ];

        for (const type of contractTypes) {
          const address = roots[type];
          if (address) {
            knownAddresses.set(checksum(address), {
              address: checksum(address),
              type,
              market,
            });
          }
        }
      } catch (err) {
        logger.debug({ rootsPath, err }, "Failed to parse roots.json");
      }
    }
  } catch (err) {
    logger.debug({ chainPath, err }, "Failed to read deployment directory");
  }

  knownAddressesCache.set(chainId, knownAddresses);
  return knownAddresses;
}

// Track which addresses we've already warned about in this session
const warnedAddresses = new Set<string>();

export const addressVerificationHandler: Handler = {
  name: "Address Verification",
  match: (ctx) => {
    // Only apply to chains that have deployment files
    if (!CHAIN_DIRECTORY[ctx.chainId]) return false;

    // Don't match if already warned about this address
    const cacheKey = `${ctx.chainId}:${checksum(ctx.target)}`;
    if (warnedAddresses.has(cacheKey)) return false;

    // Check if address is NOT in known addresses
    const knownAddresses = loadKnownAddresses(ctx.chainId);
    const targetCS = checksum(ctx.target);

    // A CometProxyAdmin is absent from roots.json but can be confirmed on-chain
    // as the admin of the proxies it upgrades; don't warn about those.
    if (isVerifiedProxyAdmin(ctx.chainId, targetCS)) return false;

    // Only warn if address is unknown
    return !knownAddresses.has(targetCS);
  },
  expand: async (ctx) => {
    const insights: InsightRequest[] = [];
    const targetCS = checksum(ctx.target);
    const cacheKey = `${ctx.chainId}:${targetCS}`;

    // Mark as warned
    warnedAddresses.add(cacheKey);

    const chainName = CHAIN_DIRECTORY[ctx.chainId] ?? `chain ${ctx.chainId}`;

    insights.push(
      insight({
        title: "⚠️ Address Verification Warning",
        entries: [
          { label: "Address", value: targetCS },
          { label: "Chain", value: `${chainName} (${ctx.chainId})` },
          {
            label: "Status",
            value: "NOT FOUND in vendor/comet/deployments roots.json",
          },
          {
            label: "Action",
            value: "Verify this address is legitimate before approving",
          },
        ],
        _handlerSource: handlerSource(HANDLER_NAME, "Checked address against vendor/comet/deployments roots.json files"),
      })
    );

    return insights;
  },
};

/**
 * Helper function to check if an address is known for a chain.
 * Can be used by other parts of the decoder.
 */
export function isKnownAddress(chainId: number, address: string): boolean {
  const knownAddresses = loadKnownAddresses(chainId);
  return knownAddresses.has(checksum(address));
}

/**
 * Get information about a known address.
 */
export function getKnownAddressInfo(chainId: number, address: string): KnownAddress | null {
  const knownAddresses = loadKnownAddresses(chainId);
  return knownAddresses.get(checksum(address)) ?? null;
}
