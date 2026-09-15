import type { JsonFragment } from "ethers";
import axios from "axios";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { checksum, ensureDir, sleep } from "@/utils";
import type { ProposalDetails, AddressMetadata, DecoderOptions, Sourced, DataSource } from "@/types";
import {
  sourced,
  etherscanAbiSource,
  etherscanSourcecodeSource,
  etherscanTagSource,
  localAbiSource,
  onChainSource,
  staticMetadataSource,
  externalApiSource,
} from "@/types/sources";
import { JsonRpcProvider, Interface } from "ethers";
import { logger } from "@/logger";
import { getLocalAbiFor, getLocalAbiPathFor } from "@/local-abi";
import { getCometMetadata, getCometAssetMetadata, getCometContractLabel, fetchCometAssetsOnChain, findCachedAssetSymbol } from "@/lib/comet-metadata";
import { getRpcUrl, getEtherscanApiKey } from "@/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const MONOREPO_ROOT = join(PACKAGE_ROOT, "..", "..");

const GOVERNOR_PROXY = "0x309a862bbC1A00e45506cB8A802D1ff10004c8C0";
const CACHE_DIR = join(MONOREPO_ROOT, ".cache");
const ABI_CACHE_DIR = join(CACHE_DIR, "abi-cache");
const CONTRACT_NAME_CACHE_DIR = join(CACHE_DIR, "contract-name-cache");
const ADDRESS_TAG_CACHE_DIR = join(CACHE_DIR, "address-tag-cache");
const TOKEN_INFO_CACHE_DIR = join(CACHE_DIR, "token-info-cache");

// Etherscan V2 base (unified across chains)
const ETHERSCAN_V2_BASE = "https://api.etherscan.io/v2/api";

// Fallback explorer APIs (Blockscout, etc.) for chains where contracts
// may be verified on an alternative explorer but not on Etherscan.
const FALLBACK_EXPLORER_APIS: Record<number, string> = {
  130: "https://unichain.blockscout.com/api", // Unichain
  534352: "https://scrollscan.com/api", // Scroll (not supported by Etherscan V2)
};

const GOVERNOR_MIN_ABI: JsonFragment[] = [
  {
    inputs: [{ internalType: "uint256", name: "proposalId", type: "uint256" }],
    name: "proposalDetails",
    outputs: [
      { internalType: "address[]", name: "targets", type: "address[]" },
      { internalType: "uint256[]", name: "values", type: "uint256[]" },
      { internalType: "bytes[]", name: "calldatas", type: "bytes[]" },
      { internalType: "bytes32", name: "descriptionHash", type: "bytes32" },
    ],
    stateMutability: "view",
    type: "function",
  },
];

function cachePathFor(address: string, chainId = 1): string {
  const cacheDir = join(ABI_CACHE_DIR, String(chainId));
  ensureDir(cacheDir);
  return join(cacheDir, `${checksum(address)}.json`);
}

function nameCachePathFor(address: string, chainId = 1): string {
  const cacheDir = join(CONTRACT_NAME_CACHE_DIR, String(chainId));
  ensureDir(cacheDir);
  return join(cacheDir, `${checksum(address)}.json`);
}

function addressTagCachePathFor(address: string, chainId = 1): string {
  const cacheDir = join(ADDRESS_TAG_CACHE_DIR, String(chainId));
  ensureDir(cacheDir);
  return join(cacheDir, `${checksum(address)}.json`);
}

function tokenInfoCachePathFor(address: string, chainId = 1): string {
  const cacheDir = join(TOKEN_INFO_CACHE_DIR, String(chainId));
  ensureDir(cacheDir);
  return join(cacheDir, `${checksum(address)}.json`);
}


/**
 * Try fetching an ABI from a fallback explorer (e.g., Blockscout) for chains
 * where contracts may not be verified on Etherscan.
 * If found, overwrites the cache so subsequent calls are fast.
 */
async function tryFallbackAbi(address: string, chainId: number): Promise<Interface | null> {
  const baseUrl = FALLBACK_EXPLORER_APIS[chainId];
  if (!baseUrl) return null;

  const checksumAddr = checksum(address);
  const url = `${baseUrl}?module=contract&action=getabi&address=${checksumAddr}`;
  try {
    logger.debug({ address: checksumAddr, chainId }, "Trying fallback explorer for ABI");
    const resp = await axios.get(url, { timeout: 15000 });
    if (resp.data?.status === "1" && resp.data?.result) {
      const abiJson = JSON.parse(resp.data.result);
      // Overwrite the cache with the real ABI
      const path = cachePathFor(address, chainId);
      writeFileSync(path, JSON.stringify(abiJson, null, 2));
      logger.debug({ address: checksumAddr, chainId }, "ABI found via fallback explorer");
      return new Interface(abiJson as JsonFragment[]);
    }
  } catch (err) {
    logger.debug({ address: checksumAddr, chainId, err }, "Fallback explorer ABI fetch failed");
  }
  return null;
}

/**
 * Try fetching a contract name from a fallback explorer (e.g., Blockscout).
 * If found, overwrites the cache.
 */
async function tryFallbackContractName(address: string, chainId: number): Promise<string | null> {
  const baseUrl = FALLBACK_EXPLORER_APIS[chainId];
  if (!baseUrl) return null;

  const checksumAddr = checksum(address);
  const url = `${baseUrl}?module=contract&action=getsourcecode&address=${checksumAddr}`;
  try {
    logger.debug({ address: checksumAddr, chainId }, "Trying fallback explorer for contract name");
    const resp = await axios.get(url, { timeout: 15000 });
    if (resp.data?.status === "1" && Array.isArray(resp.data?.result) && resp.data.result[0]?.ContractName) {
      const name = resp.data.result[0].ContractName as string;
      const path = nameCachePathFor(address, chainId);
      writeFileSync(path, JSON.stringify({ name, source: "fallback-explorer" }));
      logger.debug({ address: checksumAddr, chainId, name }, "Contract name found via fallback explorer");
      return name;
    }
  } catch (err) {
    logger.debug({ address: checksumAddr, chainId, err }, "Fallback explorer contract name fetch failed");
  }
  return null;
}

export function getProviderFor(chainId: number): JsonRpcProvider {
  const url = getRpcUrl(chainId);
  logger.trace({ chainId, url }, "Getting provider");
  if (!url)
    throw new Error(`No RPC configured for chainId=${chainId}. Set <CHAIN>_RPC_URL env vars.`);
  return new JsonRpcProvider(url);
}

export async function callProposalDetails(
  provider: JsonRpcProvider,
  governor: string,
  proposalId: bigint
): Promise<ProposalDetails> {
  const iface = new Interface(GOVERNOR_MIN_ABI);
  const data = iface.encodeFunctionData("proposalDetails", [proposalId]);
  const result = await provider.call({
    to: checksum(governor),
    data,
  });
  const decodedResult = iface.decodeFunctionResult("proposalDetails", result);

  const proposalDetails: ProposalDetails = {
    targets: decodedResult[0] as string[],
    values: (decodedResult[1] as bigint[]).map(BigInt),
    calldatas: decodedResult[2] as string[],
    descriptionHash: decodedResult[3] as string,
  };

  return proposalDetails;
}

function buildV2Params(address: string, apiKey: string, chainId?: number) {
  // V2 requires a chainid; default to 1 if not provided
  const cid = chainId ?? 1;
  return `chainid=${cid}&address=${checksum(address)}&apikey=${apiKey}`;
}

export async function getAbiFor(address: string, chainId?: number): Promise<Interface | null> {
  const path = cachePathFor(address, chainId ?? 1);
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.__note === "unverified_or_missing" || parsed?.__note === "unsupported_chain") {
        // Try fallback explorer (e.g., Blockscout)
        const fallbackAbi = await tryFallbackAbi(address, chainId ?? 1);
        if (fallbackAbi) return fallbackAbi;
        // Try local ABI fallback for known contracts
        const localAbi = getLocalAbiFor(address, chainId ?? 1);
        if (localAbi) {
          logger.debug({ address, chainId }, "Using local ABI fallback");
          return localAbi;
        }
        return null;
      }
      logger.debug({ address, chainId }, "ABI cache hit");
      return new Interface(parsed as JsonFragment[]);
    } catch {
      // cache corrupted — fall through to refetch
      logger.debug({ address, chainId }, "ABI cache corrupted");
    }
  }
  logger.debug({ address, chainId }, "ABI cache miss");

  const apiKey = getEtherscanApiKey();
  const url = `${ETHERSCAN_V2_BASE}?module=contract&action=getabi&${buildV2Params(address, apiKey, chainId)}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      logger.trace({ address, chainId, attempt }, "Fetching ABI from Etherscan");
      const resp = await axios.get(url, { timeout: 15000 });
      const status = resp.data?.status;
      const result = resp.data?.result as string | undefined;

      if (status === "1" && result) {
        const abiJson = JSON.parse(result);
        writeFileSync(path, JSON.stringify(abiJson, null, 2));
        return new Interface(abiJson as JsonFragment[]);
      } else if (status === "0" && typeof result === "string" && /rate limit/i.test(result)) {
        logger.warn("Etherscan rate limit hit, retrying...");
        await sleep(1000 * (attempt + 1));
        continue;
      } else if (
        status === "0" &&
        typeof result === "string" &&
        /Missing|unsupported chainid/i.test(result)
      ) {
        // Chain not supported by Etherscan V2 - try fallback explorer, then local ABI
        logger.debug({ address, chainId }, "Chain not supported by Etherscan V2");
        const fallbackAbi = await tryFallbackAbi(address, chainId ?? 1);
        if (fallbackAbi) return fallbackAbi;
        writeFileSync(path, JSON.stringify({ __note: "unsupported_chain" }, null, 2));
        const localAbi = getLocalAbiFor(address, chainId ?? 1);
        if (localAbi) {
          logger.debug({ address, chainId }, "Using local ABI fallback");
          return localAbi;
        }
        return null;
      } else {
        // unverified or other failure - try fallback explorer, then local ABI
        logger.debug({ address, chainId }, "Contract not verified on Etherscan");
        const fallbackAbi = await tryFallbackAbi(address, chainId ?? 1);
        if (fallbackAbi) return fallbackAbi;
        writeFileSync(path, JSON.stringify({ __note: "unverified_or_missing" }, null, 2));
        const localAbi = getLocalAbiFor(address, chainId ?? 1);
        if (localAbi) {
          logger.debug({ address, chainId }, "Using local ABI fallback");
          return localAbi;
        }
        return null;
      }
    } catch (err: unknown) {
      if (attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new Error(
        `Failed to fetch ABI for ${address}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return null;
}

export async function getContractName(address: string, chainId?: number): Promise<string | null> {
  const path = nameCachePathFor(address, chainId ?? 1);
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.name) {
        logger.debug({ address, chainId }, "Contract name cache hit");
        return parsed.name;
      }
      // Cache has null - try fallback explorer, then comet-metadata
      const fallbackName = await tryFallbackContractName(address, chainId ?? 1);
      if (fallbackName) return fallbackName;
      const cometLabel = getCometContractLabel(chainId ?? 1, address);
      if (cometLabel) {
        logger.debug({ address, chainId, cometLabel }, "Using comet-metadata for cached null contract name");
        return cometLabel;
      }
      return null;
    } catch {
      // corrupted cache — fall through
      logger.debug({ address, chainId }, "Contract name cache corrupted");
    }
  }
  logger.debug({ address, chainId }, "Contract name cache miss");

  const apiKey = getEtherscanApiKey();
  const url = `${ETHERSCAN_V2_BASE}?module=contract&action=getsourcecode&${buildV2Params(
    address,
    apiKey,
    chainId
  )}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      logger.trace({ address, chainId, attempt }, "Fetching contract name from Etherscan");
      const resp = await axios.get(url, { timeout: 15000 });
      const status = resp.data?.status;
      const resultArr = resp.data?.result;

      if (status === "1" && Array.isArray(resultArr) && resultArr[0]?.ContractName) {
        const name = resultArr[0].ContractName as string;
        writeFileSync(path, JSON.stringify({ name, source: "etherscan" }));
        return name;
      } else if (
        status === "0" &&
        typeof resp.data?.result === "string" &&
        /rate limit/i.test(resp.data.result)
      ) {
        logger.warn("Etherscan rate limit hit, retrying...");
        await sleep(1000 * (attempt + 1));
        continue;
      } else if (
        resp.data?.message === "NOTOK" &&
        typeof resp.data?.result === "string" &&
        /Invalid API Key/i.test(resp.data.result)
      ) {
        throw new Error(`Invalid Etherscan API key.`);
      } else if (
        status === "0" &&
        typeof resp.data?.result === "string" &&
        /Missing|unsupported chainid/i.test(resp.data.result)
      ) {
        // Chain not supported by Etherscan V2 - try fallback, then comet-metadata
        logger.debug({ address, chainId }, "Chain not supported by Etherscan V2 for contract name");
        const fallbackName = await tryFallbackContractName(address, chainId ?? 1);
        if (fallbackName) return fallbackName;
        const cometLabel = getCometContractLabel(chainId ?? 1, address);
        if (cometLabel) {
          logger.debug({ address, chainId, cometLabel }, "Using comet-metadata for contract name");
          writeFileSync(path, JSON.stringify({ name: cometLabel, source: "comet-metadata" }));
          return cometLabel;
        }
        writeFileSync(path, JSON.stringify({ name: null }));
        return null;
      } else {
        // Etherscan can be flaky — back off and retry
        await sleep(1000 * (attempt + 1));
        continue;
      }
    } catch {
      if (attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
    }
  }

  // Cache sentinel for not found - try fallback explorer, then comet-metadata
  logger.debug({ address, chainId }, "Contract name not found on Etherscan");
  const fallbackName = await tryFallbackContractName(address, chainId ?? 1);
  if (fallbackName) return fallbackName;
  const cometLabel = getCometContractLabel(chainId ?? 1, address);
  if (cometLabel) {
    logger.debug({ address, chainId, cometLabel }, "Using comet-metadata for contract name");
    writeFileSync(path, JSON.stringify({ name: cometLabel, source: "comet-metadata" }));
    return cometLabel;
  }
  writeFileSync(path, JSON.stringify({ name: null }));
  return null;
}

type AddressTagInfo = {
  nameTag: string | null;
  labels: string[];
  otherAttributes: string[];
  url?: string | null;
  shortDescription?: string | null;
  notes?: string[];
};

async function getAddressTagInfo(address: string, chainId?: number): Promise<AddressTagInfo> {
  const path = addressTagCachePathFor(address, chainId ?? 1);
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw);
      return {
        nameTag: typeof parsed.nameTag === "string" ? parsed.nameTag : null,
        labels: Array.isArray(parsed.labels)
          ? parsed.labels.filter((l: unknown): l is string => typeof l === "string")
          : [],
        otherAttributes: Array.isArray(parsed.otherAttributes)
          ? parsed.otherAttributes.filter((l: unknown): l is string => typeof l === "string")
          : [],
        url: typeof parsed.url === "string" ? parsed.url : null,
        shortDescription:
          typeof parsed.shortDescription === "string" ? parsed.shortDescription : null,
        notes: Array.isArray(parsed.notes)
          ? parsed.notes.filter((l: unknown): l is string => typeof l === "string")
          : undefined,
      } satisfies AddressTagInfo;
    } catch {
      logger.debug({ address, chainId }, "Address tag cache corrupted");
    }
  }

  const apiKey = getEtherscanApiKey();
  const params = buildV2Params(address, apiKey, chainId);
  const url = `${ETHERSCAN_V2_BASE}?module=nametag&action=getaddresstag&${params}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      logger.trace({ address, chainId, attempt }, "Fetching address metadata from Etherscan");
      const resp = await axios.get(url, { timeout: 15000 });
      const status: string | undefined = resp.data?.status;
      const result = resp.data?.result;
      if (status === "1" && Array.isArray(result) && result.length > 0) {
        const entry = result[0] as Record<string, unknown>;
        const nameTag =
          typeof entry.nametag === "string" && entry.nametag.trim().length
            ? entry.nametag.trim()
            : null;
        const labels = Array.isArray(entry.labels)
          ? entry.labels.filter(
              (l): l is string => typeof l === "string" && l.trim().length > 0
            )
          : [];
        const otherAttributes = Array.isArray(entry.other_attributes)
          ? entry.other_attributes.filter(
              (attr): attr is string => typeof attr === "string" && attr.trim().length > 0
            )
          : [];
        const shortDescription =
          typeof entry.shortdescription === "string" && entry.shortdescription.trim().length
            ? entry.shortdescription.trim()
            : null;
        const notes = [entry.notes_1, entry.notes_2]
          .map((n) => (typeof n === "string" && n.trim().length ? n.trim() : null))
          .filter((n): n is string => Boolean(n));
        const payload = {
          nameTag,
          labels,
          otherAttributes,
          url:
            typeof entry.url === "string" && entry.url.trim().length ? entry.url.trim() : null,
          shortDescription,
          notes: notes.length ? notes : undefined,
        } satisfies AddressTagInfo;
        writeFileSync(path, JSON.stringify(payload, null, 2));
        return payload;
      }

      if (status === "0" && typeof resp.data?.result === "string") {
        const message = resp.data.result;
        if (/rate limit/i.test(message)) {
          logger.warn("Etherscan rate limit hit, retrying address metadata...");
          await sleep(1000 * (attempt + 1));
          continue;
        }

        if (/Missing|unsupported chainid/i.test(message) || /invalid Action name/i.test(message)) {
          logger.debug({ address, chainId, message }, "Address metadata not available for chain");
          break;
        }

        logger.debug({ address, chainId, message }, "Unexpected address metadata response");
        break;
      }

      if (status !== "1") {
        logger.debug({ address, chainId, status, result }, "Unhandled address metadata response");
        break;
      }
    } catch (err) {
      if (attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      logger.debug({ address, chainId, err }, "Failed to fetch address metadata; returning empty");
      break;
    }
  }

  const payload = {
    nameTag: null,
    labels: [],
    otherAttributes: [],
    url: null,
    shortDescription: null,
  } satisfies AddressTagInfo;
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return payload;
}

// =============================================================================
// Explorer token page scraping (precise tickers like USDC.e)
// =============================================================================

export type EtherscanTokenInfo = {
  symbol: string | null;
  name: string | null;
  decimals: number | null;
};

type CachedTokenInfo = EtherscanTokenInfo & { _v?: number };
const TOKEN_INFO_CACHE_VERSION = 3;

const EXPLORER_BASE_URLS: Record<number, string> = {
  1: "https://etherscan.io",
  10: "https://optimistic.etherscan.io",
  130: "https://uniscan.xyz",
  137: "https://polygonscan.com",
  5000: "https://mantlescan.xyz",
  8453: "https://basescan.org",
  42161: "https://arbiscan.io",
  59144: "https://lineascan.build",
  534352: "https://scrollscan.com",
};

/** Pick the longer of two candidate symbols (longer ≈ more informative, e.g. "USDC.e" > "USDC"). */
export function longestSymbol(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return b.length > a.length ? b : a;
}

/**
 * Parse token name and symbol from the explorer page.
 * Tries multiple strategies:
 * 1. <title> tag: "TokenName (SYMBOL) | ERC-20 | Address: 0x... | ChainName"
 * 2. JSON-LD: {"name": "TokenName (SYMBOL)", ...}
 * 3. JS variable: var litAssetSymbol = "SYMBOL";
 */
function parseTokenPage(html: string): EtherscanTokenInfo {
  // Strategy 1: <title> tag
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const title = titleMatch[1].trim();
    const tokenMatch = title.match(/^(.+?)\s*\(([^)]+)\)\s*\|/);
    if (tokenMatch) {
      const name = tokenMatch[1].trim() || null;
      const symbol = tokenMatch[2].trim() || null;
      if (symbol) return { symbol, name, decimals: null };
    }
  }

  // Strategy 2: JSON-LD schema {"name": "TokenName (SYMBOL)"}
  const jsonLdMatch = html.match(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (typeof ld.name === "string") {
        const ldTokenMatch = ld.name.match(/^(.+?)\s*\(([^)]+)\)$/);
        if (ldTokenMatch) {
          const name = ldTokenMatch[1].trim() || null;
          const symbol = ldTokenMatch[2].trim() || null;
          if (symbol) return { symbol, name, decimals: null };
        }
      }
    } catch { /* malformed JSON-LD */ }
  }

  // Strategy 3: JS variable litAssetSymbol
  const litMatch = html.match(/var\s+litAssetSymbol\s*=\s*"([^"]+)"/);
  if (litMatch) {
    return { symbol: litMatch[1].trim(), name: null, decimals: null };
  }

  return { symbol: null, name: null, decimals: null };
}

/**
 * Fetch token info by scraping the explorer's /token/ page title.
 * Returns the precise token ticker as listed on the explorer (e.g., "USDC.e" not "USDC").
 */
export async function getEtherscanTokenInfo(address: string, chainId?: number): Promise<EtherscanTokenInfo> {
  const cid = chainId ?? 1;
  const checksumAddr = checksum(address);
  const path = tokenInfoCachePathFor(address, cid);

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8");
      const cached = JSON.parse(raw) as CachedTokenInfo;
      if (cached._v === TOKEN_INFO_CACHE_VERSION) {
        return { symbol: cached.symbol, name: cached.name, decimals: cached.decimals };
      }
    } catch {
      // corrupted cache
    }
  }

  const explorerBase = EXPLORER_BASE_URLS[cid];
  if (!explorerBase) {
    const empty: CachedTokenInfo = { symbol: null, name: null, decimals: null, _v: TOKEN_INFO_CACHE_VERSION };
    writeFileSync(path, JSON.stringify(empty, null, 2));
    return { symbol: null, name: null, decimals: null };
  }

  const url = `${explorerBase}/token/${checksumAddr}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      logger.trace({ address: checksumAddr, chainId: cid, attempt }, "Fetching token page from explorer");
      const resp = await axios.get(url, {
        timeout: 10000,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; proposal-decoder/1.0)" },
        maxContentLength: 500_000,
        responseType: "text",
      });

      if (typeof resp.data === "string") {
        const info = parseTokenPage(resp.data);
        if (info.symbol) {
          const cached: CachedTokenInfo = { ...info, _v: TOKEN_INFO_CACHE_VERSION };
          writeFileSync(path, JSON.stringify(cached, null, 2));
          return info;
        }
      }
      break;
    } catch {
      if (attempt < 1) {
        await sleep(1000);
        continue;
      }
    }
  }

  const empty: CachedTokenInfo = { symbol: null, name: null, decimals: null, _v: TOKEN_INFO_CACHE_VERSION };
  writeFileSync(path, JSON.stringify(empty, null, 2));
  return { symbol: null, name: null, decimals: null };
}

/** Main entry */

import detectProxy from "./lib/evm-proxy-detection/index";
import { ProxyType } from "./lib/evm-proxy-detection/types";

export async function getImplementationAddress(
  provider: JsonRpcProvider,
  address: string
): Promise<string | null> {
  const request = ({ method, params }: { method: string; params: unknown[] }) =>
    provider.send(method, params);

  const res = await detectProxy(address as `0x${string}`, request);
  if (!res) return null;
  if (res.type === ProxyType.Eip2535Diamond) return null;
  return res.target;
}

// (Optional) export the constant if used elsewhere
export { GOVERNOR_PROXY };

// =============================================================================
// Source-tracked types
// =============================================================================

/** Address metadata with source tracking for each field */
export type SourcedAddressMetadata = {
  contractName?: Sourced<string | null>;
  etherscanLabel?: Sourced<string | null>;
  tokenSymbol?: Sourced<string | null>;
  tokenName?: Sourced<string | null>;
  tokenDecimals?: Sourced<number | null>;
  baseTokenSymbol?: Sourced<string | null>;
  baseTokenDecimals?: Sourced<number | null>;
  labels?: Sourced<string[]>;
  ensName?: Sourced<string | null>;
  url?: Sourced<string | null>;
  description?: Sourced<string | null>;
  notes?: Sourced<string[]>;
  implementation?: Sourced<{
    address: string;
    contractName?: string | null;
    etherscanLabel?: string | null;
    tokenSymbol?: string | null;
    tokenName?: string | null;
    tokenDecimals?: number | null;
    labels?: string[];
    ensName?: string | null;
  }>;
};

/** Map of address -> SourcedAddressMetadata */
export type SourcedAddressMetadataMap = Record<string, SourcedAddressMetadata>;

/** Result from getAbiFor with source tracking */
export type SourcedAbi = {
  iface: Interface;
  source: DataSource;
};

/** Result from getContractName with source tracking */
export type SourcedContractName = Sourced<string | null>;

// =============================================================================
// Source-tracked getAbiFor
// =============================================================================

/**
 * Get ABI for an address with source tracking.
 * Returns both the Interface and the source of the ABI.
 */
export async function getAbiForWithSource(
  address: string,
  chainId?: number
): Promise<SourcedAbi | null> {
  const cid = chainId ?? 1;
  const path = cachePathFor(address, cid);
  const checksumAddr = checksum(address);

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.__note === "unverified_or_missing" || parsed?.__note === "unsupported_chain") {
        // Try fallback explorer (e.g., Blockscout)
        const fallbackAbi = await tryFallbackAbi(address, cid);
        if (fallbackAbi) {
          const baseUrl = FALLBACK_EXPLORER_APIS[cid];
          return {
            iface: fallbackAbi,
            source: externalApiSource("blockscout", `${baseUrl}?module=contract&action=getabi&address=${checksumAddr}`),
          };
        }
        // Try local ABI fallback
        const localAbi = getLocalAbiFor(address, cid);
        if (localAbi) {
          const localPath = getLocalAbiPathFor(address, cid);
          return {
            iface: localAbi,
            source: localAbiSource(localPath ?? "unknown", undefined),
          };
        }
        return null;
      }
      return {
        iface: new Interface(parsed as JsonFragment[]),
        source: etherscanAbiSource(cid, checksumAddr),
      };
    } catch {
      // cache corrupted
    }
  }

  // Fetch from Etherscan
  const apiKey = getEtherscanApiKey();
  const url = `${ETHERSCAN_V2_BASE}?module=contract&action=getabi&${buildV2Params(address, apiKey, chainId)}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await axios.get(url, { timeout: 15000 });
      const status = resp.data?.status;
      const result = resp.data?.result as string | undefined;

      if (status === "1" && result) {
        const abiJson = JSON.parse(result);
        writeFileSync(path, JSON.stringify(abiJson, null, 2));
        return {
          iface: new Interface(abiJson as JsonFragment[]),
          source: etherscanAbiSource(cid, checksumAddr),
        };
      } else if (status === "0" && typeof result === "string" && /rate limit/i.test(result)) {
        await sleep(1000 * (attempt + 1));
        continue;
      } else if (status === "0" && typeof result === "string" && /Missing|unsupported chainid/i.test(result)) {
        const fallbackAbi = await tryFallbackAbi(address, cid);
        if (fallbackAbi) {
          const baseUrl = FALLBACK_EXPLORER_APIS[cid];
          return {
            iface: fallbackAbi,
            source: externalApiSource("blockscout", `${baseUrl}?module=contract&action=getabi&address=${checksumAddr}`),
          };
        }
        writeFileSync(path, JSON.stringify({ __note: "unsupported_chain" }, null, 2));
        const localAbi = getLocalAbiFor(address, cid);
        if (localAbi) {
          const localPath = getLocalAbiPathFor(address, cid);
          return {
            iface: localAbi,
            source: localAbiSource(localPath ?? "unknown", undefined),
          };
        }
        return null;
      } else {
        const fallbackAbi = await tryFallbackAbi(address, cid);
        if (fallbackAbi) {
          const baseUrl = FALLBACK_EXPLORER_APIS[cid];
          return {
            iface: fallbackAbi,
            source: externalApiSource("blockscout", `${baseUrl}?module=contract&action=getabi&address=${checksumAddr}`),
          };
        }
        writeFileSync(path, JSON.stringify({ __note: "unverified_or_missing" }, null, 2));
        const localAbi = getLocalAbiFor(address, cid);
        if (localAbi) {
          const localPath = getLocalAbiPathFor(address, cid);
          return {
            iface: localAbi,
            source: localAbiSource(localPath ?? "unknown", undefined),
          };
        }
        return null;
      }
    } catch (err) {
      if (attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new Error(
        `Failed to fetch ABI for ${address}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return null;
}

// =============================================================================
// Source-tracked getContractName
// =============================================================================

/**
 * Get contract name with source tracking.
 */
export async function getContractNameWithSource(
  address: string,
  chainId?: number
): Promise<SourcedContractName | null> {
  const cid = chainId ?? 1;
  const checksumAddr = checksum(address);
  const path = nameCachePathFor(address, cid);

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as { name?: string | null; source?: "etherscan" | "comet-metadata" };
      if (parsed.name) {
        // Use the correct source based on what was cached
        if (parsed.source === "comet-metadata") {
          return sourced(
            parsed.name,
            staticMetadataSource(`vendor/comet/deployments/*/roots.json`, "contract-label", undefined)
          );
        } else {
          // Default to Etherscan for legacy cache entries
          return sourced(parsed.name, etherscanSourcecodeSource(cid, checksumAddr, true));
        }
      }
      // Cache has null - try fallback explorer, then comet-metadata
      const fallbackName = await tryFallbackContractName(address, cid);
      if (fallbackName) {
        const baseUrl = FALLBACK_EXPLORER_APIS[cid];
        return sourced(fallbackName, externalApiSource("blockscout", `${baseUrl}?module=contract&action=getsourcecode&address=${checksumAddr}`));
      }
      const cometLabel = getCometContractLabel(cid, address);
      if (cometLabel) {
        // Update cache with correct source
        writeFileSync(path, JSON.stringify({ name: cometLabel, source: "comet-metadata" }));
        return sourced(
          cometLabel,
          staticMetadataSource(`vendor/comet/deployments/*/roots.json`, "contract-label", undefined)
        );
      }
      return null;
    } catch {
      // corrupted cache
    }
  }

  // Fetch from Etherscan
  const apiKey = getEtherscanApiKey();
  const url = `${ETHERSCAN_V2_BASE}?module=contract&action=getsourcecode&${buildV2Params(address, apiKey, chainId)}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await axios.get(url, { timeout: 15000 });
      const status = resp.data?.status;
      const resultArr = resp.data?.result;

      if (status === "1" && Array.isArray(resultArr) && resultArr[0]?.ContractName) {
        const name = resultArr[0].ContractName as string;
        writeFileSync(path, JSON.stringify({ name, source: "etherscan" }));
        return sourced(name, etherscanSourcecodeSource(cid, checksumAddr, true));
      } else if (status === "0" && typeof resp.data?.result === "string" && /rate limit/i.test(resp.data.result)) {
        await sleep(1000 * (attempt + 1));
        continue;
      } else if (resp.data?.message === "NOTOK" && typeof resp.data?.result === "string" && /Invalid API Key/i.test(resp.data.result)) {
        throw new Error(`Invalid Etherscan API key.`);
      } else if (status === "0" && typeof resp.data?.result === "string" && /Missing|unsupported chainid/i.test(resp.data.result)) {
        const fallbackName = await tryFallbackContractName(address, cid);
        if (fallbackName) {
          const baseUrl = FALLBACK_EXPLORER_APIS[cid];
          return sourced(fallbackName, externalApiSource("blockscout", `${baseUrl}?module=contract&action=getsourcecode&address=${checksumAddr}`));
        }
        const cometLabel = getCometContractLabel(cid, address);
        if (cometLabel) {
          writeFileSync(path, JSON.stringify({ name: cometLabel, source: "comet-metadata" }));
          return sourced(
            cometLabel,
            staticMetadataSource(`vendor/comet/deployments/*/roots.json`, "contract-label", undefined)
          );
        }
        writeFileSync(path, JSON.stringify({ name: null }));
        return null;
      } else {
        await sleep(1000 * (attempt + 1));
        continue;
      }
    } catch {
      if (attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
    }
  }

  // Fallback to fallback explorer, then comet-metadata
  const fallbackName = await tryFallbackContractName(address, cid);
  if (fallbackName) {
    const baseUrl = FALLBACK_EXPLORER_APIS[cid];
    return sourced(fallbackName, externalApiSource("blockscout", `${baseUrl}?module=contract&action=getsourcecode&address=${checksumAddr}`));
  }
  const cometLabel = getCometContractLabel(cid, address);
  if (cometLabel) {
    writeFileSync(path, JSON.stringify({ name: cometLabel, source: "comet-metadata" }));
    return sourced(
      cometLabel,
      staticMetadataSource(`vendor/comet/deployments/*/roots.json`, "contract-label", undefined)
    );
  }
  writeFileSync(path, JSON.stringify({ name: null }));
  return null;
}

// =============================================================================
// Source-tracked getAddressMetadata
// =============================================================================

export async function getAddressMetadata(
  address: string,
  chainId?: number
): Promise<AddressMetadata>;
export async function getAddressMetadata(
  address: string,
  chainId: number | undefined,
  options: DecoderOptions & { trackSources: true }
): Promise<SourcedAddressMetadata>;
export async function getAddressMetadata(
  address: string,
  chainId?: number,
  options?: DecoderOptions
): Promise<AddressMetadata | SourcedAddressMetadata>;
export async function getAddressMetadata(
  address: string,
  chainId?: number,
  options?: DecoderOptions
): Promise<AddressMetadata | SourcedAddressMetadata> {
  const trackSources = options?.trackSources ?? false;
  const cid = chainId ?? 1;
  const checksumAddr = checksum(address);

  if (trackSources) {
    return getAddressMetadataWithSources(checksumAddr, cid);
  }

  // Original implementation (no source tracking)
  const [nameResult, infoResult] = await Promise.allSettled([
    getContractName(address, chainId),
    getAddressTagInfo(address, chainId),
  ]);

  const metadata: AddressMetadata = {};

  if (nameResult.status === "fulfilled") {
    metadata.contractName = nameResult.value;
  } else {
    logger.debug(
      { address, chainId, err: nameResult.reason },
      "Failed to resolve contract name for address argument"
    );
  }

  if (infoResult.status === "fulfilled") {
    const tagInfo = infoResult.value;
    metadata.labels = tagInfo.labels;
    metadata.url = tagInfo.url ?? undefined;
    metadata.description = tagInfo.shortDescription ?? undefined;
    metadata.notes = tagInfo.notes;

    if (!metadata.etherscanLabel) {
      const labelCandidate = tagInfo.nameTag ?? tagInfo.labels?.[0];
      if (labelCandidate) {
        metadata.etherscanLabel = labelCandidate;
      }
    }

    const contractNameAttr = tagInfo.otherAttributes.find((attr) =>
      typeof attr === "string" && attr.toUpperCase().startsWith("CN:")
    );
    if (!metadata.contractName && contractNameAttr) {
      const extracted = contractNameAttr.split(":").slice(1).join(":").trim();
      if (extracted.length) {
        metadata.contractName = extracted;
      }
    }

    const ensAttr = tagInfo.otherAttributes.find((attr) =>
      typeof attr === "string" && attr.toUpperCase().startsWith("ENS:")
    );
    if (ensAttr) {
      const extracted = ensAttr.split(":").slice(1).join(":").trim();
      if (extracted.length) {
        metadata.ensName = extracted;
      }
    }

    const tokenSymbolAttr = tagInfo.otherAttributes.find((attr) =>
      typeof attr === "string" && attr.toUpperCase().startsWith("TS:")
    );
    if (tokenSymbolAttr) {
      const extracted = tokenSymbolAttr.split(":").slice(1).join(":").trim();
      if (extracted.length) {
        metadata.tokenSymbol = extracted;
      }
    }
  } else {
    logger.debug(
      { address, chainId, err: infoResult.reason },
      "Failed to resolve Etherscan tag for address argument"
    );
  }

  // Try Comet metadata - prefer it over generic Etherscan labels
  if (chainId) {
    // Generic contract names that should be overridden by better metadata
    const isGenericLabel = (name: string | null | undefined) =>
      !name ||
      [
        "TransparentUpgradeableProxy",
        "ERC1967Proxy",
        "UUPSProxy",
        "Proxy",
        "ERC20",
        "Token",
      ].some((generic) => name?.includes(generic));

    // Try to find as a token/asset from static metadata
    const assetMeta = getCometAssetMetadata(chainId, address);
    if (assetMeta) {
      if (!metadata.tokenSymbol || isGenericLabel(metadata.contractName)) {
        metadata.tokenSymbol = assetMeta.symbol;
      }
      if (assetMeta.name && isGenericLabel(metadata.contractName)) {
        metadata.contractName = assetMeta.name;
      }
    }

    // Try to find as a known Comet contract
    const cometLabel = getCometContractLabel(chainId, address);
    if (cometLabel && isGenericLabel(metadata.contractName)) {
      metadata.contractName = cometLabel;
    }

    // Check on-chain asset cache
    if (!metadata.tokenSymbol && isGenericLabel(metadata.contractName)) {
      const cachedSymbol = findCachedAssetSymbol(chainId, address);
      if (cachedSymbol) {
        metadata.tokenSymbol = cachedSymbol;
      }
    }

    // Resolve token symbol from explorer + on-chain, keep the longest
    if (metadata.tokenSymbol || isGenericLabel(metadata.contractName)) {
      const explorerToken = await getEtherscanTokenInfo(address, chainId);
      if (explorerToken.symbol) {
        metadata.tokenSymbol = longestSymbol(metadata.tokenSymbol, explorerToken.symbol);
      }
      if (explorerToken.name) {
        metadata.tokenName = explorerToken.name;
      }

      // Always try on-chain for symbol comparison + missing decimals
      try {
        const provider = getProviderFor(chainId);
        const erc20Iface = new Interface([
          "function symbol() view returns (string)",
          "function name() view returns (string)",
          "function decimals() view returns (uint8)",
        ]);

        const calls = await Promise.allSettled([
          provider.call({ to: address, data: erc20Iface.encodeFunctionData("symbol") }),
          !metadata.tokenName
            ? provider.call({ to: address, data: erc20Iface.encodeFunctionData("name") })
            : Promise.reject("skip"),
          metadata.tokenDecimals == null
            ? provider.call({ to: address, data: erc20Iface.encodeFunctionData("decimals") })
            : Promise.reject("skip"),
        ]);

        if (calls[0].status === "fulfilled") {
          const [symbol] = erc20Iface.decodeFunctionResult("symbol", calls[0].value);
          if (symbol && typeof symbol === "string") {
            metadata.tokenSymbol = longestSymbol(metadata.tokenSymbol, symbol);
          }
        }
        if (!metadata.tokenName && calls[1].status === "fulfilled") {
          const [name] = erc20Iface.decodeFunctionResult("name", calls[1].value);
          if (name && typeof name === "string") metadata.tokenName = name;
        }
        if (metadata.tokenDecimals == null && calls[2].status === "fulfilled") {
          const [decimals] = erc20Iface.decodeFunctionResult("decimals", calls[2].value);
          if (decimals != null) metadata.tokenDecimals = Number(decimals);
        }
      } catch {
        // Not an ERC20 token or RPC error, ignore
      }
    }

    // Always detect base token for Comet proxies (known from metadata or on-chain)
    const cometMeta = getCometMetadata(chainId, address);
    if (cometMeta?.baseTokenAddress) {
      // Known Comet proxy: get symbol from explorer, static config AND on-chain, keep longest
      const baseExplorer = await getEtherscanTokenInfo(cometMeta.baseTokenAddress, chainId);
      const bestStatic = baseExplorer.symbol ?? cometMeta.baseTokenSymbol ?? null;
      try {
        const provider = getProviderFor(chainId);
        const erc20Iface = new Interface([
          "function symbol() view returns (string)",
          "function decimals() view returns (uint8)",
        ]);
        const [symRes, decRes] = await Promise.allSettled([
          provider.call({ to: cometMeta.baseTokenAddress, data: erc20Iface.encodeFunctionData("symbol") }),
          metadata.baseTokenDecimals == null
            ? provider.call({ to: cometMeta.baseTokenAddress, data: erc20Iface.encodeFunctionData("decimals") })
            : Promise.reject("skip"),
        ]);
        const onChainSymbol = symRes.status === "fulfilled"
          ? (erc20Iface.decodeFunctionResult("symbol", symRes.value)[0] as string)
          : null;
        metadata.baseTokenSymbol = longestSymbol(bestStatic, onChainSymbol);
        if (metadata.baseTokenDecimals == null && decRes.status === "fulfilled") {
          const [dec] = erc20Iface.decodeFunctionResult("decimals", decRes.value);
          if (dec != null) metadata.baseTokenDecimals = Number(dec);
        }
      } catch {
        metadata.baseTokenSymbol = bestStatic;
      }
    } else if (!metadata.baseTokenSymbol) {
      // Unknown address: try on-chain baseToken() detection
      try {
        const provider = getProviderFor(chainId);
        const baseTokenIface = new Interface(["function baseToken() view returns (address)"]);
        const baseTokenResult = await provider.call({
          to: address,
          data: baseTokenIface.encodeFunctionData("baseToken"),
        });
        const [baseTokenAddr] = baseTokenIface.decodeFunctionResult("baseToken", baseTokenResult);
        if (baseTokenAddr && typeof baseTokenAddr === "string") {
          const baseExplorer = await getEtherscanTokenInfo(baseTokenAddr, chainId);
          const erc20Iface = new Interface([
            "function symbol() view returns (string)",
            "function decimals() view returns (uint8)",
          ]);
          const [symRes, decRes] = await Promise.allSettled([
            provider.call({ to: baseTokenAddr, data: erc20Iface.encodeFunctionData("symbol") }),
            metadata.baseTokenDecimals == null
              ? provider.call({ to: baseTokenAddr, data: erc20Iface.encodeFunctionData("decimals") })
              : Promise.reject("skip"),
          ]);
          const onChainSymbol = symRes.status === "fulfilled"
            ? (erc20Iface.decodeFunctionResult("symbol", symRes.value)[0] as string)
            : null;
          metadata.baseTokenSymbol = longestSymbol(baseExplorer.symbol, onChainSymbol);
          if (metadata.baseTokenDecimals == null && decRes.status === "fulfilled") {
            const [dec] = erc20Iface.decodeFunctionResult("decimals", decRes.value);
            if (dec != null) metadata.baseTokenDecimals = Number(dec);
          }
        }
      } catch {
        // Not a Comet proxy, ignore
      }
    }
  }

  return metadata;
}

// =============================================================================
// Helper: getAddressMetadataWithSources
// =============================================================================

async function getAddressMetadataWithSources(
  address: string,
  chainId: number
): Promise<SourcedAddressMetadata> {
  const checksumAddr = checksum(address);
  const metadata: SourcedAddressMetadata = {};

  // Get contract name with source
  const nameSourced = await getContractNameWithSource(checksumAddr, chainId);
  if (nameSourced) {
    metadata.contractName = nameSourced;
  }

  // Get tag info
  const tagInfo = await getAddressTagInfo(checksumAddr, chainId);
  if (tagInfo.labels.length > 0) {
    metadata.labels = sourced(tagInfo.labels, etherscanTagSource(chainId, checksumAddr, "label"));
  }
  if (tagInfo.url) {
    metadata.url = sourced(tagInfo.url, etherscanTagSource(chainId, checksumAddr, "attribute"));
  }
  if (tagInfo.shortDescription) {
    metadata.description = sourced(
      tagInfo.shortDescription,
      etherscanTagSource(chainId, checksumAddr, "attribute")
    );
  }
  if (tagInfo.notes && tagInfo.notes.length > 0) {
    metadata.notes = sourced(tagInfo.notes, etherscanTagSource(chainId, checksumAddr, "attribute"));
  }

  // Etherscan label
  const labelCandidate = tagInfo.nameTag ?? tagInfo.labels?.[0];
  if (labelCandidate) {
    metadata.etherscanLabel = sourced(
      labelCandidate,
      etherscanTagSource(chainId, checksumAddr, tagInfo.nameTag ? "nametag" : "label")
    );
  }

  // Extract from attributes
  const contractNameAttr = tagInfo.otherAttributes.find(
    (attr) => typeof attr === "string" && attr.toUpperCase().startsWith("CN:")
  );
  if (!metadata.contractName && contractNameAttr) {
    const extracted = contractNameAttr.split(":").slice(1).join(":").trim();
    if (extracted.length) {
      metadata.contractName = sourced(
        extracted,
        etherscanTagSource(chainId, checksumAddr, "attribute")
      );
    }
  }

  const ensAttr = tagInfo.otherAttributes.find(
    (attr) => typeof attr === "string" && attr.toUpperCase().startsWith("ENS:")
  );
  if (ensAttr) {
    const extracted = ensAttr.split(":").slice(1).join(":").trim();
    if (extracted.length) {
      metadata.ensName = sourced(
        extracted,
        etherscanTagSource(chainId, checksumAddr, "attribute")
      );
    }
  }

  const tokenSymbolAttr = tagInfo.otherAttributes.find(
    (attr) => typeof attr === "string" && attr.toUpperCase().startsWith("TS:")
  );
  if (tokenSymbolAttr) {
    const extracted = tokenSymbolAttr.split(":").slice(1).join(":").trim();
    if (extracted.length) {
      metadata.tokenSymbol = sourced(
        extracted,
        etherscanTagSource(chainId, checksumAddr, "attribute")
      );
    }
  }

  // Helper for generic label detection
  const isGenericLabel = (name: string | null | undefined) =>
    !name ||
    ["TransparentUpgradeableProxy", "ERC1967Proxy", "UUPSProxy", "Proxy", "ERC20", "Token"].some(
      (generic) => name?.includes(generic)
    );

  const contractNameValue = metadata.contractName?.value;

  // Try Comet metadata
  const assetMeta = getCometAssetMetadata(chainId, checksumAddr);
  if (assetMeta) {
    if (!metadata.tokenSymbol || isGenericLabel(contractNameValue)) {
      metadata.tokenSymbol = sourced(
        assetMeta.symbol,
        staticMetadataSource(
          `vendor/comet/deployments/*/configuration.json`,
          `assets.${assetMeta.symbol}`,
          undefined
        )
      );
    }
    if (assetMeta.name && isGenericLabel(contractNameValue)) {
      metadata.contractName = sourced(
        assetMeta.name,
        staticMetadataSource(
          `vendor/comet/deployments/*/configuration.json`,
          `assets.${assetMeta.symbol}.name`,
          undefined
        )
      );
    }
  }

  // Try Comet contract label
  const cometLabel = getCometContractLabel(chainId, checksumAddr);
  if (cometLabel && isGenericLabel(metadata.contractName?.value)) {
    metadata.contractName = sourced(
      cometLabel,
      staticMetadataSource(`vendor/comet/deployments/*/roots.json`, "contract-label", undefined)
    );
  }

  // Check on-chain asset cache
  if (!metadata.tokenSymbol && isGenericLabel(metadata.contractName?.value)) {
    const cachedSymbol = findCachedAssetSymbol(chainId, checksumAddr);
    if (cachedSymbol) {
      metadata.tokenSymbol = sourced(
        cachedSymbol,
        onChainSource(chainId, checksumAddr, "symbol()", [])
      );
    }
  }

  // Resolve token symbol from explorer + on-chain, keep the longest
  if (metadata.tokenSymbol || isGenericLabel(metadata.contractName?.value)) {
    const explorerToken = await getEtherscanTokenInfo(checksumAddr, chainId);
    const explorerSource = externalApiSource(
      "etherscan-explorer",
      `${EXPLORER_BASE_URLS[chainId] ?? "https://etherscan.io"}/token/${checksumAddr}`
    );
    // Extract current raw symbol value
    const currentRaw = metadata.tokenSymbol
      ? (typeof metadata.tokenSymbol === "object" && "value" in metadata.tokenSymbol
          ? (metadata.tokenSymbol as Sourced<string>).value
          : metadata.tokenSymbol as unknown as string)
      : null;

    // Collect all candidates: current, explorer, on-chain
    let bestSymbol = currentRaw;
    let bestSource: DataSource | undefined;

    if (explorerToken.symbol) {
      bestSymbol = longestSymbol(bestSymbol, explorerToken.symbol);
      if (bestSymbol === explorerToken.symbol) bestSource = explorerSource;
    }
    if (explorerToken.name) {
      metadata.tokenName = sourced(explorerToken.name, explorerSource);
    }

    // Always try on-chain for symbol comparison + missing decimals
    try {
      const provider = getProviderFor(chainId);
      const erc20Iface = new Interface([
        "function symbol() view returns (string)",
        "function name() view returns (string)",
        "function decimals() view returns (uint8)",
      ]);

      const calls = await Promise.allSettled([
        provider.call({ to: checksumAddr, data: erc20Iface.encodeFunctionData("symbol") }),
        !metadata.tokenName
          ? provider.call({ to: checksumAddr, data: erc20Iface.encodeFunctionData("name") })
          : Promise.reject("skip"),
        metadata.tokenDecimals == null
          ? provider.call({ to: checksumAddr, data: erc20Iface.encodeFunctionData("decimals") })
          : Promise.reject("skip"),
      ]);

      if (calls[0].status === "fulfilled") {
        const [symbol] = erc20Iface.decodeFunctionResult("symbol", calls[0].value);
        if (symbol && typeof symbol === "string") {
          const prev = bestSymbol;
          bestSymbol = longestSymbol(bestSymbol, symbol);
          if (bestSymbol === symbol && bestSymbol !== prev) {
            bestSource = onChainSource(chainId, checksumAddr, "symbol()", []);
          }
        }
      }
      if (!metadata.tokenName && calls[1].status === "fulfilled") {
        const [name] = erc20Iface.decodeFunctionResult("name", calls[1].value);
        if (name && typeof name === "string") {
          metadata.tokenName = sourced(name, onChainSource(chainId, checksumAddr, "name()", []));
        }
      }
      if (metadata.tokenDecimals == null && calls[2].status === "fulfilled") {
        const [decimals] = erc20Iface.decodeFunctionResult("decimals", calls[2].value);
        if (decimals !== undefined && decimals !== null) {
          metadata.tokenDecimals = sourced(Number(decimals), onChainSource(chainId, checksumAddr, "decimals()", []));
        }
      }
    } catch {
      // Not an ERC20 token or RPC error, ignore
    }

    // Apply the longest symbol
    if (bestSymbol && bestSymbol !== currentRaw) {
      metadata.tokenSymbol = sourced(bestSymbol, bestSource ?? explorerSource);
    } else if (bestSymbol && !metadata.tokenSymbol) {
      metadata.tokenSymbol = sourced(bestSymbol, bestSource ?? explorerSource);
    }
  }

  // Always detect base token for Comet proxies (known from metadata or on-chain)
  const cometMeta = getCometMetadata(chainId, checksumAddr);
  if (cometMeta?.baseTokenAddress) {
    // Known Comet proxy: get symbol from explorer, static config AND on-chain, keep longest
    const baseExplorer = await getEtherscanTokenInfo(cometMeta.baseTokenAddress, chainId);
    const bestStatic = baseExplorer.symbol ?? cometMeta.baseTokenSymbol ?? null;
    try {
      const provider = getProviderFor(chainId);
      const erc20Iface = new Interface([
        "function symbol() view returns (string)",
        "function decimals() view returns (uint8)",
      ]);
      const [symRes, decRes] = await Promise.allSettled([
        provider.call({ to: cometMeta.baseTokenAddress, data: erc20Iface.encodeFunctionData("symbol") }),
        metadata.baseTokenDecimals == null
          ? provider.call({ to: cometMeta.baseTokenAddress, data: erc20Iface.encodeFunctionData("decimals") })
          : Promise.reject("skip"),
      ]);
      const onChainSymbol = symRes.status === "fulfilled"
        ? (erc20Iface.decodeFunctionResult("symbol", symRes.value)[0] as string)
        : null;
      const finalSymbol = longestSymbol(bestStatic, onChainSymbol);
      if (finalSymbol) {
        const useOnChain = finalSymbol === onChainSymbol && finalSymbol !== bestStatic;
        const baseSource = useOnChain
          ? onChainSource(chainId, cometMeta.baseTokenAddress, "symbol()", [])
          : baseExplorer.symbol
            ? externalApiSource(
                "etherscan-explorer",
                `${EXPLORER_BASE_URLS[chainId] ?? "https://etherscan.io"}/token/${cometMeta.baseTokenAddress}`
              )
            : staticMetadataSource(
                `vendor/comet/deployments/*/configuration.json`,
                `baseTokenSymbol`,
                undefined
              );
        metadata.baseTokenSymbol = sourced(finalSymbol, baseSource);
      }
      if (metadata.baseTokenDecimals == null && decRes.status === "fulfilled") {
        const [dec] = erc20Iface.decodeFunctionResult("decimals", decRes.value);
        if (dec != null) {
          metadata.baseTokenDecimals = sourced(
            Number(dec),
            onChainSource(chainId, cometMeta.baseTokenAddress, "decimals()", [])
          );
        }
      }
    } catch {
      if (bestStatic) {
        const baseSource = baseExplorer.symbol
          ? externalApiSource(
              "etherscan-explorer",
              `${EXPLORER_BASE_URLS[chainId] ?? "https://etherscan.io"}/token/${cometMeta.baseTokenAddress}`
            )
          : staticMetadataSource(
              `vendor/comet/deployments/*/configuration.json`,
              `baseTokenSymbol`,
              undefined
            );
        metadata.baseTokenSymbol = sourced(bestStatic, baseSource);
      }
    }
  } else if (!metadata.baseTokenSymbol) {
    // Unknown address: try on-chain baseToken() detection
    try {
      const provider = getProviderFor(chainId);
      const baseTokenIface = new Interface(["function baseToken() view returns (address)"]);
      const baseTokenResult = await provider.call({
        to: checksumAddr,
        data: baseTokenIface.encodeFunctionData("baseToken"),
      });
      const [baseTokenAddr] = baseTokenIface.decodeFunctionResult("baseToken", baseTokenResult);
      if (baseTokenAddr && typeof baseTokenAddr === "string") {
        const baseExplorer = await getEtherscanTokenInfo(baseTokenAddr, chainId);
        const erc20Iface = new Interface([
          "function symbol() view returns (string)",
          "function decimals() view returns (uint8)",
        ]);
        const [symRes, decRes] = await Promise.allSettled([
          provider.call({ to: baseTokenAddr, data: erc20Iface.encodeFunctionData("symbol") }),
          metadata.baseTokenDecimals == null
            ? provider.call({ to: baseTokenAddr, data: erc20Iface.encodeFunctionData("decimals") })
            : Promise.reject("skip"),
        ]);
        const onChainSymbol = symRes.status === "fulfilled"
          ? (erc20Iface.decodeFunctionResult("symbol", symRes.value)[0] as string)
          : null;
        const finalSymbol = longestSymbol(baseExplorer.symbol, onChainSymbol);
        if (finalSymbol) {
          const useOnChain = finalSymbol === onChainSymbol && finalSymbol !== baseExplorer.symbol;
          metadata.baseTokenSymbol = sourced(
            finalSymbol,
            useOnChain
              ? onChainSource(chainId, baseTokenAddr, "symbol()", [])
              : externalApiSource(
                  "etherscan-explorer",
                  `${EXPLORER_BASE_URLS[chainId] ?? "https://etherscan.io"}/token/${baseTokenAddr}`
                )
          );
        }
        if (metadata.baseTokenDecimals == null && decRes.status === "fulfilled") {
          const [dec] = erc20Iface.decodeFunctionResult("decimals", decRes.value);
          if (dec != null) {
            metadata.baseTokenDecimals = sourced(
              Number(dec),
              onChainSource(chainId, baseTokenAddr, "decimals()", [])
            );
          }
        }
      }
    } catch {
      // Not a Comet proxy, ignore
    }
  }

  return metadata;
}
