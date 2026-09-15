import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { checksum } from "@/utils";
import { getChainDirectory as getChainDirectoryFromConfig } from "@/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..", "..");
const MONOREPO_ROOT = join(PACKAGE_ROOT, "..", "..");

// Hardcoded labels for addresses not in roots.json
// Keyed by chainId -> checksummed address -> label
const HARDCODED_CONTRACT_LABELS: Record<number, Record<string, string>> = {
  // Add hardcoded labels here if needed for addresses not in roots.json
};

export type CometAssetMetadata = {
  symbol: string;
  name?: string | null;
  address: string;
  decimals?: number;
  // Configuration values (from configuration.json)
  borrowCF?: number;
  liquidateCF?: number;
  liquidationFactor?: number;
  supplyCap?: string; // Raw string like "400000e6"
};

export type CometRatesConfig = {
  borrowBase?: number;
  borrowSlopeLow?: number;
  borrowKink?: number;
  borrowSlopeHigh?: number;
  supplyBase?: number;
  supplySlopeLow?: number;
  supplyKink?: number;
  supplySlopeHigh?: number;
};

export type CometMetadata = {
  name: string;
  symbol: string;
  baseTokenSymbol?: string;
  baseTokenAddress?: string;
  cometAddress: string;
  configuratorAddress: string;
  assetsByAddress: Record<string, CometAssetMetadata>;
  rates?: CometRatesConfig;
  // Additional contract addresses from roots.json
  rewardsAddress?: string;
  cometFactoryAddress?: string;
  bridgeReceiverAddress?: string;
  bulkerAddress?: string;
  cometProxyAdminAddress?: string;
  l2CCIPRouterAddress?: string;
  l2CCIPOffRampAddress?: string;
  l2TokenAdminRegistryAddress?: string;
  l2NativeBridgeAddress?: string;
};

// Fallback for chains not in the config (testnet/dev chains)
const FALLBACK_CHAIN_DIRECTORY: Record<number, string> = {
  43113: "fuji",
  11155111: "sepolia",
  5: "hardhat",
};

function getChainDirectory(chainId: number): string | undefined {
  // First try the config file
  const fromConfig = getChainDirectoryFromConfig(chainId);
  if (fromConfig) return fromConfig;
  // Fallback for testnet/dev chains
  return FALLBACK_CHAIN_DIRECTORY[chainId];
}

const DEPLOYMENTS_ROOT = join(MONOREPO_ROOT, "vendor", "comet", "deployments");

type ChainMetadata = {
  byComet: Map<string, CometMetadata>;
};

const chainCache = new Map<number, ChainMetadata>();

export function getCometMetadata(chainId: number, cometAddress: string): CometMetadata | null {
  const chainMeta = ensureChainMetadata(chainId);
  if (!chainMeta) return null;
  return chainMeta.byComet.get(checksum(cometAddress)) ?? null;
}

/** Every market the vendored deployments describe for `chainId`. */
export function listCometMetadata(chainId: number): CometMetadata[] {
  const chainMeta = ensureChainMetadata(chainId);
  if (!chainMeta) return [];
  return [...chainMeta.byComet.values()];
}

function ensureChainMetadata(chainId: number): ChainMetadata | null {
  if (chainCache.has(chainId)) return chainCache.get(chainId)!;

  const dirName = getChainDirectory(chainId);
  if (!dirName) {
    chainCache.set(chainId, { byComet: new Map() });
    return chainCache.get(chainId)!;
  }

  const chainPath = join(DEPLOYMENTS_ROOT, dirName);
  const metadata: ChainMetadata = { byComet: new Map() };

  if (!existsSync(chainPath)) {
    chainCache.set(chainId, metadata);
    return metadata;
  }

  const assetDirs = readdirSync(chainPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const assetDir of assetDirs) {
    const folderPath = join(chainPath, assetDir);
    const rootsPath = join(folderPath, "roots.json");
    const configPath = join(folderPath, "configuration.json");
    if (!existsSync(rootsPath) || !existsSync(configPath)) {
      continue;
    }

    try {
      const rootsRaw = JSON.parse(readFileSync(rootsPath, "utf8")) as Record<string, unknown>;
      const configurationRaw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;

      const cometAddress = checksum(String(rootsRaw.comet));
      const configuratorAddress = checksum(String(rootsRaw.configurator));

      const assetsByAddress: Record<string, CometAssetMetadata> = {};
      const assets = configurationRaw.assets as Record<string, any> | undefined;
      if (assets) {
        for (const [assetSymbol, assetValue] of Object.entries(assets)) {
          const address = assetValue?.address as string | undefined;
          if (!address) continue;
          const entry: CometAssetMetadata = {
            symbol: assetSymbol,
            name: assetValue?.name ?? null,
            address: checksum(address),
            decimals: parseOptionalNumber(assetValue?.decimals),
            borrowCF: parseOptionalNumber(assetValue?.borrowCF),
            liquidateCF: parseOptionalNumber(assetValue?.liquidateCF),
            liquidationFactor: parseOptionalNumber(assetValue?.liquidationFactor),
            supplyCap: typeof assetValue?.supplyCap === "string" ? assetValue.supplyCap : undefined,
          };
          assetsByAddress[entry.address] = entry;
        }
      }

      const name = typeof configurationRaw.name === "string" ? configurationRaw.name : assetDir;
      const symbol = typeof configurationRaw.symbol === "string" ? configurationRaw.symbol : assetDir;
      const baseTokenSymbol =
        typeof configurationRaw.baseToken === "string" ? configurationRaw.baseToken : undefined;
      const baseTokenAddressRaw = configurationRaw.baseTokenAddress;
      const baseTokenAddress =
        typeof baseTokenAddressRaw === "string" && baseTokenAddressRaw
          ? checksum(baseTokenAddressRaw)
          : undefined;

      // Parse rates configuration
      const ratesRaw = configurationRaw.rates as Record<string, unknown> | undefined;
      const rates: CometRatesConfig | undefined = ratesRaw
        ? {
            borrowBase: parseOptionalNumber(ratesRaw.borrowBase),
            borrowSlopeLow: parseOptionalNumber(ratesRaw.borrowSlopeLow),
            borrowKink: parseOptionalNumber(ratesRaw.borrowKink),
            borrowSlopeHigh: parseOptionalNumber(ratesRaw.borrowSlopeHigh),
            supplyBase: parseOptionalNumber(ratesRaw.supplyBase),
            supplySlopeLow: parseOptionalNumber(ratesRaw.supplySlopeLow),
            supplyKink: parseOptionalNumber(ratesRaw.supplyKink),
            supplySlopeHigh: parseOptionalNumber(ratesRaw.supplySlopeHigh),
          }
        : undefined;

      // Helper to optionally checksum address from roots
      const optionalAddress = (key: string): string | undefined => {
        const raw = rootsRaw[key];
        return typeof raw === "string" && raw ? checksum(raw) : undefined;
      };

      const cometMetadata: CometMetadata = {
        name,
        symbol,
        baseTokenSymbol,
        baseTokenAddress,
        cometAddress,
        configuratorAddress,
        assetsByAddress,
        rates,
        // Additional contract addresses from roots.json
        rewardsAddress: optionalAddress("rewards"),
        cometFactoryAddress: optionalAddress("cometFactory"),
        bridgeReceiverAddress: optionalAddress("bridgeReceiver"),
        bulkerAddress: optionalAddress("bulker"),
        cometProxyAdminAddress: optionalAddress("cometProxyAdmin"),
        l2CCIPRouterAddress: optionalAddress("l2CCIPRouter"),
        l2CCIPOffRampAddress: optionalAddress("l2CCIPOffRamp"),
        l2TokenAdminRegistryAddress: optionalAddress("l2TokenAdminRegistry"),
        l2NativeBridgeAddress: optionalAddress("roninl2NativeBridge"),
      };

      metadata.byComet.set(cometAddress, cometMetadata);
    } catch (err) {
      console.error("Failed to parse comet metadata", chainId, assetDir, err);
    }
  }

  chainCache.set(chainId, metadata);
  return metadata;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length) {
    const parsed = Number(value.replace(/[^0-9.\-eE]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Get asset metadata by address across all markets for a chain.
 * Useful for looking up token symbols when Etherscan doesn't support the chain.
 */
export function getCometAssetMetadata(
  chainId: number,
  assetAddress: string
): CometAssetMetadata | null {
  const chainMeta = ensureChainMetadata(chainId);
  if (!chainMeta) return null;

  const assetCS = checksum(assetAddress);

  // Search across all markets for this asset
  for (const cometMeta of chainMeta.byComet.values()) {
    const assetMeta = cometMeta.assetsByAddress[assetCS];
    if (assetMeta) return assetMeta;
  }

  return null;
}

/**
 * Get a label for a known Comet contract address.
 * Returns the contract type and market name if found.
 *
 * @param chainId - The chain ID
 * @param contractAddress - The contract address to get a label for
 * @param cometProxyHint - Optional hint: if provided and the contract is shared
 *                         across markets (e.g., Configurator), use this Comet
 *                         address to determine which market's label to return.
 */
export function getCometContractLabel(
  chainId: number,
  contractAddress: string,
  cometProxyHint?: string
): string | null {
  const chainMeta = ensureChainMetadata(chainId);
  if (!chainMeta) return null;

  const addrCS = checksum(contractAddress);
  const hintCS = cometProxyHint ? checksum(cometProxyHint) : null;

  // If we have a hint, try to look up that specific market first
  if (hintCS) {
    const hintedMeta = chainMeta.byComet.get(hintCS);
    if (hintedMeta) {
      const label = getLabelFromMetadata(hintedMeta, addrCS);
      if (label) return label;
    }
  }

  // Fall back to searching all markets. A Configurator is shared by every market
  // on the chain, so naming the first market that happens to match would claim a
  // market this call has nothing to do with — label it neutrally instead.
  const sharesConfigurator = [...chainMeta.byComet.values()].filter(
    (m) => m.configuratorAddress === addrCS
  );
  if (sharesConfigurator.length > 1) return "Configurator (shared by all markets)";

  for (const cometMeta of chainMeta.byComet.values()) {
    const label = getLabelFromMetadata(cometMeta, addrCS);
    if (label) return label;
  }

  // Fallback to hardcoded labels for addresses not in roots.json
  const hardcodedLabels = HARDCODED_CONTRACT_LABELS[chainId];
  if (hardcodedLabels) {
    const label = hardcodedLabels[addrCS];
    if (label) return label;
  }

  return null;
}

/**
 * Helper to get a label for a contract address from a specific market's metadata.
 */
function getLabelFromMetadata(cometMeta: CometMetadata, addrCS: string): string | null {
  // Check if it's the comet itself
  if (cometMeta.cometAddress === addrCS) {
    return `${cometMeta.name} (${cometMeta.symbol})`;
  }
  // Check if it's the configurator
  if (cometMeta.configuratorAddress === addrCS) {
    return `Configurator for ${cometMeta.name}`;
  }
  // Check if it's the base token
  if (cometMeta.baseTokenAddress === addrCS) {
    return cometMeta.baseTokenSymbol ?? null;
  }
  // Check additional contract types from roots.json
  if (cometMeta.rewardsAddress === addrCS) {
    return `Rewards for ${cometMeta.name}`;
  }
  if (cometMeta.cometFactoryAddress === addrCS) {
    return `CometFactory for ${cometMeta.name}`;
  }
  if (cometMeta.bridgeReceiverAddress === addrCS) {
    return `BridgeReceiver for ${cometMeta.name}`;
  }
  if (cometMeta.bulkerAddress === addrCS) {
    return `Bulker for ${cometMeta.name}`;
  }
  if (cometMeta.cometProxyAdminAddress === addrCS) {
    return `CometProxyAdmin for ${cometMeta.name}`;
  }
  if (cometMeta.l2CCIPRouterAddress === addrCS) {
    return `L2 CCIP Router for ${cometMeta.name}`;
  }
  if (cometMeta.l2CCIPOffRampAddress === addrCS) {
    return `L2 CCIP OffRamp for ${cometMeta.name}`;
  }
  if (cometMeta.l2TokenAdminRegistryAddress === addrCS) {
    return `L2 Token Admin Registry for ${cometMeta.name}`;
  }
  if (cometMeta.l2NativeBridgeAddress === addrCS) {
    return `L2 Native Bridge for ${cometMeta.name}`;
  }
  return null;
}

// ============================================================================
// On-chain asset fetching from Comet contracts
// ============================================================================

import type { JsonRpcProvider } from "ethers";
import { Interface } from "ethers";

const COMET_ASSET_ABI = [
  "function numAssets() view returns (uint8)",
  "function getAssetInfo(uint8 i) view returns (uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap)",
  "function baseToken() view returns (address)",
  "function baseTokenPriceFeed() view returns (address)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
];

// Cache for on-chain fetched assets: chainId -> cometAddress -> assetAddress -> symbol
const onChainAssetCache = new Map<number, Map<string, Map<string, string>>>();

/**
 * Fetch asset symbol from an ERC20 token on-chain
 */
async function fetchTokenSymbol(provider: JsonRpcProvider, tokenAddress: string): Promise<string | null> {
  try {
    const iface = new Interface(ERC20_ABI);
    const data = iface.encodeFunctionData("symbol");
    const result = await provider.call({ to: tokenAddress, data });
    const [symbol] = iface.decodeFunctionResult("symbol", result);
    return symbol;
  } catch {
    return null;
  }
}

/**
 * Fetch all collateral assets from a Comet contract on-chain
 */
export async function fetchCometAssetsOnChain(
  provider: JsonRpcProvider,
  cometAddress: string,
  chainId: number
): Promise<Map<string, string>> {
  const cometCS = checksum(cometAddress);

  // Check cache
  let chainCache = onChainAssetCache.get(chainId);
  if (!chainCache) {
    chainCache = new Map();
    onChainAssetCache.set(chainId, chainCache);
  }

  const cached = chainCache.get(cometCS);
  if (cached) return cached;

  const assets = new Map<string, string>();

  try {
    const iface = new Interface(COMET_ASSET_ABI);

    // Get number of assets
    const numAssetsData = iface.encodeFunctionData("numAssets");
    const numAssetsResult = await provider.call({ to: cometAddress, data: numAssetsData });
    const [numAssets] = iface.decodeFunctionResult("numAssets", numAssetsResult);

    // Fetch each asset
    for (let i = 0; i < Number(numAssets); i++) {
      try {
        const getAssetData = iface.encodeFunctionData("getAssetInfo", [i]);
        const assetResult = await provider.call({ to: cometAddress, data: getAssetData });
        const assetInfo = iface.decodeFunctionResult("getAssetInfo", assetResult);
        const assetAddress = checksum(assetInfo.asset);

        // Fetch symbol
        const symbol = await fetchTokenSymbol(provider, assetAddress);
        if (symbol) {
          assets.set(assetAddress, symbol);
        }
      } catch {
        // Skip individual asset errors
      }
    }

    // Also fetch base token
    try {
      const baseTokenData = iface.encodeFunctionData("baseToken");
      const baseTokenResult = await provider.call({ to: cometAddress, data: baseTokenData });
      const [baseToken] = iface.decodeFunctionResult("baseToken", baseTokenResult);
      const baseTokenCS = checksum(baseToken);

      const baseSymbol = await fetchTokenSymbol(provider, baseTokenCS);
      if (baseSymbol) {
        assets.set(baseTokenCS, baseSymbol);
      }
    } catch {
      // Ignore base token fetch errors
    }
  } catch {
    // Return empty map on error
  }

  // Cache results
  chainCache.set(cometCS, assets);
  return assets;
}

/**
 * Get asset symbol from on-chain cache (must call fetchCometAssetsOnChain first)
 */
export function getCachedAssetSymbol(chainId: number, cometAddress: string, assetAddress: string): string | null {
  const chainCache = onChainAssetCache.get(chainId);
  if (!chainCache) return null;

  const cometCS = checksum(cometAddress);
  const assetCS = checksum(assetAddress);

  const cometAssets = chainCache.get(cometCS);
  if (!cometAssets) return null;

  return cometAssets.get(assetCS) ?? null;
}

/**
 * Search all cached Comets for an asset symbol
 */
export function findCachedAssetSymbol(chainId: number, assetAddress: string): string | null {
  const chainCache = onChainAssetCache.get(chainId);
  if (!chainCache) return null;

  const assetCS = checksum(assetAddress);

  for (const cometAssets of chainCache.values()) {
    const symbol = cometAssets.get(assetCS);
    if (symbol) return symbol;
  }

  return null;
}
