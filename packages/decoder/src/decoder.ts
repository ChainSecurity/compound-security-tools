import { Interface, FunctionFragment, ParamType, keccak256, toUtf8Bytes } from "ethers";
import { logger } from "./logger.js";

import {
  getProviderFor,
  callProposalDetails,
  getAbiFor,
  getAbiForWithSource,
  getImplementationAddress,
  getContractName,
  getContractNameWithSource,
  getAddressMetadata,
  GOVERNOR_PROXY,
} from "@/ethers.js";

import { checksum, toReadableArg } from "./utils.js";
import { unwrap } from "./types/sources.js";
import type {
  AddressMetadata,
  CallNode,
  DecodedFunction,
  DecodedProposal,
  ProposalDetails,
  SerializableParamInfo,
  DecoderOptions,
  DataSource,
  Sourced,
} from "./types.js";
import {
  sourced,
  calldataSource,
  etherscanAbiSource,
  etherscanSourcecodeSource,
  onChainSource,
  staticMetadataSource,
  hardcodedSource,
  handlerSource,
  proposalParameterSource,
} from "./types/sources.js";
import { Registry, type SiblingCalls } from "./registry.js";
import { lineaBridgeHandler } from "./handlers/linea-bridge-handler.js";
import { lineaBridgeReceiverHandler } from "./handlers/linea-receiver-handler.js";
import { scrollBridgeHandler } from "./handlers/scroll-bridge-handler.js";
import { scrollBridgeReceiverHandler } from "./handlers/scroll-receiver-handler.js";
import { opCrossDomainMessengerHandler } from "./handlers/op-cdm-handler.js";
import { opReceiverHandler } from "./handlers/op-receiver-handler.js";
import { arbitrumRetryableHandler } from "./handlers/arbitrum-inbox-handler.js";
import { arbitrumReceiverHandler } from "./handlers/arbitrum-receiver-handler.js";
import { polygonFxRootHandler } from "./handlers/polygon-fxroot-handler.js";
import { polygonReceiverHandler } from "./handlers/polygon-receiver-handler.js";
import { ccipRouterHandler } from "./handlers/ccip-router-handler.js";
import { ccipReceiverHandler } from "./handlers/ccip-receiver-handler.js";
import { cometConfiguratorInsightsHandler } from "./handlers/comet-configurator-insights.js";
import { assetConfigInsightsHandler } from "./handlers/asset-config-insights.js";
import { addressVerificationHandler } from "./handlers/address-verification-handler.js";
import { cometConfiguratorPriceFeedInsightsHandler } from "./handlers/comet-configurator-price-feed-insights.js";
import { cometTrackingSpeedHandler } from "./handlers/comet-tracking-speed-handler.js";
import { cometProxyAdminHandler } from "./handlers/comet-proxy-admin-handler.js";
import { timelockControllerHandler } from "./handlers/timelock-controller-handler.js";
import { safeExecTransactionHandler } from "./handlers/safe-exec-transaction-handler.js";
import { cometFactoryVersionHandler } from "./handlers/comet-factory-version-handler.js";
import { cometExtensionDelegateHandler } from "./handlers/comet-extension-delegate-handler.js";
import { getCometContractLabel } from "./lib/comet-metadata.js";

// ---------------------- Constants ----------------------

const ETHEREUM_MAINNET_CHAIN_ID = 1;

// Build the registry once (add more handlers as you implement them)
const registry = new Registry().use([
  lineaBridgeHandler,
  lineaBridgeReceiverHandler,
  scrollBridgeHandler,
  scrollBridgeReceiverHandler,
  opCrossDomainMessengerHandler,
  opReceiverHandler,
  arbitrumRetryableHandler,
  arbitrumReceiverHandler,
  polygonFxRootHandler,
  polygonReceiverHandler,
  ccipRouterHandler,
  ccipReceiverHandler,
  timelockControllerHandler,
  safeExecTransactionHandler,
  cometConfiguratorInsightsHandler,
  assetConfigInsightsHandler,
  cometProxyAdminHandler,
  addressVerificationHandler,
  cometConfiguratorPriceFeedInsightsHandler,
  cometTrackingSpeedHandler,
  cometFactoryVersionHandler,
  cometExtensionDelegateHandler,
]);

// ---------------------- Small helpers ----------------------

function selectorOf(data: string): string {
  if (!data || data === "0x") return "0x00000000";
  return data.slice(0, 10);
}

function fragmentSignature(fn: FunctionFragment): string {
  return `${fn.name}(${fn.inputs.map((p: ParamType) => p.format("full")).join(",")})`;
}

/** Convert a ParamType to a serializable format for the portal */
function toSerializableParamInfo(param: ParamType): SerializableParamInfo {
  return {
    name: param.name || "",
    type: param.type,
    baseType: param.baseType,
    components: param.components?.map(toSerializableParamInfo),
    arrayChildren: param.arrayChildren ? toSerializableParamInfo(param.arrayChildren) : undefined,
  };
}

function decodeWithInterface(
  iface: Interface,
  calldata: string,
  options?: DecoderOptions,
  abiSource?: DataSource
): DecodedFunction | undefined {
  try {
    const parsed = iface.parseTransaction({ data: calldata });
    if (!parsed) return undefined;

    const fn = iface.getFunction(parsed.selector);
    if (!fn) return undefined;

    const rawArgs = Array.from(parsed.args);
    const trackSources = options?.trackSources ?? false;
    const selectorHex = selectorOf(calldata);
    const sig = fragmentSignature(fn);

    // Build result with or without source tracking
    const result: DecodedFunction = trackSources ? {
      name: sourced(parsed.name, abiSource ?? etherscanAbiSource(1, "unknown")),
      signature: sourced(sig, abiSource ?? etherscanAbiSource(1, "unknown")),
      selector: sourced(selectorHex, calldataSource(0, 4, selectorHex, "selector")),
      args: parsed.args.map(toReadableArg),
      argSources: calculateArgSources(calldata, fn.inputs),
      argTypes: fn.inputs.map((i: ParamType) => i.format("full")),
      argParams: fn.inputs as ParamType[],
      argParamInfo: fn.inputs.map(toSerializableParamInfo),
      rawArgs,
    } : {
      name: parsed.name,
      signature: sig,
      selector: selectorHex,
      args: parsed.args.map(toReadableArg),
      argTypes: fn.inputs.map((i: ParamType) => i.format("full")),
      argParams: fn.inputs as ParamType[],
      argParamInfo: fn.inputs.map(toSerializableParamInfo),
      rawArgs,
    };

    return result;
  } catch {
    return undefined;
  }
}

/**
 * Calculate calldata source info for each argument.
 * This provides byte offset, length, and raw bytes for each decoded argument.
 */
function calculateArgSources(calldata: string, inputs: readonly ParamType[]): DataSource[] {
  const sources: DataSource[] = [];
  const dataWithoutSelector = calldata.slice(10); // Remove 0x and 4-byte selector

  // Track position in the calldata (after selector = byte 4)
  let currentOffset = 4;

  for (let i = 0; i < inputs.length; i++) {
    const param = inputs[i];
    const isStatic = isStaticType(param);

    if (isStatic) {
      // Static types are 32 bytes each, inline
      const startByte = currentOffset;
      const length = 32;
      const startHex = (startByte - 4) * 2; // Position in dataWithoutSelector
      const rawBytes = "0x" + dataWithoutSelector.slice(startHex, startHex + length * 2);

      sources.push(calldataSource(startByte, length, rawBytes, "abi"));
      currentOffset += 32;
    } else {
      // Dynamic types: the slot contains an offset pointer
      const pointerSlotStart = currentOffset;
      const pointerHex = (pointerSlotStart - 4) * 2;
      const pointerValue = parseInt(dataWithoutSelector.slice(pointerHex, pointerHex + 64), 16);

      // The actual data starts at the offset from the beginning of args (after selector)
      const dataStart = 4 + pointerValue;

      // For simplicity, capture a reasonable chunk (up to 256 bytes or end of calldata)
      const dataStartHex = pointerValue * 2;
      const remainingHex = dataWithoutSelector.slice(dataStartHex);
      const captureLength = Math.min(remainingHex.length / 2, 256);
      const rawBytes = "0x" + remainingHex.slice(0, captureLength * 2);

      sources.push(calldataSource(dataStart, captureLength, rawBytes, "abi"));
      currentOffset += 32; // The pointer slot is still 32 bytes
    }
  }

  return sources;
}

/**
 * Check if a Solidity type is static (fixed size in ABI encoding)
 */
function isStaticType(param: ParamType): boolean {
  // Dynamic types: bytes, string, arrays (T[]), and tuples containing dynamic types
  if (param.baseType === "bytes" && param.type === "bytes") return false;
  if (param.baseType === "string") return false;
  if (param.baseType === "array") return false;

  // Fixed-size bytes (bytes1-bytes32) are static
  if (param.baseType === "bytes" && /^bytes\d+$/.test(param.type)) return true;

  // Tuples: static only if all components are static
  if (param.baseType === "tuple" && param.components) {
    return param.components.every(isStaticType);
  }

  // Everything else (address, uint, int, bool, bytesN) is static
  return true;
}

/**
 * Extract a cometProxy address from decoded function arguments.
 * This is used to refine contract labels for shared contracts (e.g., Configurator).
 * Looks for parameters named "cometProxy", "comet", or the first address parameter
 * in functions that are known Configurator methods.
 */
function extractCometProxyHint(decoded: DecodedFunction): string | null {
  if (!decoded.argParams || !decoded.rawArgs) return null;

  // Known Configurator function patterns where first param is cometProxy
  const CONFIGURATOR_FUNCTIONS = [
    "setBaseTokenPriceFeed",
    "updateAsset",
    "updateAssetPriceFeed",
    "updateAssetBorrowCollateralFactor",
    "updateAssetLiquidateCollateralFactor",
    "updateAssetLiquidationFactor",
    "updateAssetSupplyCap",
    "setBorrowPerYearInterestRateBase",
    "setBorrowPerYearInterestRateSlopeLow",
    "setBorrowPerYearInterestRateSlopeHigh",
    "setBorrowKink",
    "setSupplyPerYearInterestRateBase",
    "setSupplyPerYearInterestRateSlopeLow",
    "setSupplyPerYearInterestRateSlopeHigh",
    "setSupplyKink",
    "setStoreFrontPriceFactor",
    "setBaseTrackingSupplySpeed",
    "setBaseTrackingBorrowSpeed",
    "setBaseMinForRewards",
    "setBaseBorrowMin",
    "setTargetReserves",
  ];

  // CometProxyAdmin functions where cometProxy is the second param
  const PROXY_ADMIN_FUNCTIONS = ["deployAndUpgradeTo"];

  // Unwrap name for comparison (it may be sourced)
  const decodedName = unwrap(decoded.name);

  // Check if this is a known Configurator function
  const isConfiguratorFunction = CONFIGURATOR_FUNCTIONS.some(
    (name) => decodedName === name || decodedName?.startsWith(name)
  );

  // Check if this is a CometProxyAdmin function
  const isProxyAdminFunction = PROXY_ADMIN_FUNCTIONS.some(
    (name) => decodedName === name || decodedName?.startsWith(name)
  );

  for (let i = 0; i < decoded.argParams.length; i++) {
    const param = decoded.argParams[i];
    const arg = decoded.rawArgs[i];

    // Look for parameters explicitly named cometProxy or comet
    const paramName = param.name?.toLowerCase() ?? "";
    if (paramName === "cometproxy" || paramName === "comet") {
      if (typeof arg === "string" && /^0x[0-9a-fA-F]{40}$/.test(arg)) {
        return checksum(arg);
      }
    }

    // For known Configurator functions, use the first address parameter
    if (isConfiguratorFunction && i === 0 && param.type === "address") {
      if (typeof arg === "string" && /^0x[0-9a-fA-F]{40}$/.test(arg)) {
        return checksum(arg);
      }
    }

    // For CometProxyAdmin functions, use the second address parameter (cometProxy)
    if (isProxyAdminFunction && i === 1 && param.type === "address") {
      if (typeof arg === "string" && /^0x[0-9a-fA-F]{40}$/.test(arg)) {
        return checksum(arg);
      }
    }
  }

  return null;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function asChecksumAddress(value: unknown): string | null {
  if (typeof value === "string") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
    try {
      return checksum(value);
    } catch {
      return null;
    }
  }

  if (
    value &&
    typeof value === "object" &&
    "toString" in value &&
    typeof (value as { toString(): unknown }).toString === "function"
  ) {
    const asString = String((value as { toString(): string }).toString());
    if (!/^0x[0-9a-fA-F]{40}$/.test(asString)) return null;
    try {
      return checksum(asString);
    } catch {
      return null;
    }
  }

  return null;
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && "length" in value) {
    try {
      return Array.from(value as unknown as Iterable<unknown>);
    } catch {
      return [];
    }
  }
  return [];
}

function collectAddressesFromParam(
  param: ParamType,
  value: unknown,
  acc: Set<string>
): void {
  if (!param) return;

  if (param.baseType === "address") {
    const addr = asChecksumAddress(value);
    if (addr && addr !== ZERO_ADDRESS) {
      acc.add(addr);
    }
    return;
  }

  if (param.baseType === "array" && param.arrayChildren) {
    const values = toArray(value);
    for (const item of values) {
      collectAddressesFromParam(param.arrayChildren, item, acc);
    }
    return;
  }

  if (param.baseType === "tuple" && param.components) {
    if (!value || typeof value !== "object") return;
    const arrayValue = Array.isArray(value) ? value : undefined;
    param.components.forEach((component, index) => {
      const tupleValue =
        arrayValue?.[index] ?? (value as Record<string | number, unknown>)[component.name] ?? (value as Record<string | number, unknown>)[index];
      collectAddressesFromParam(component, tupleValue, acc);
    });
  }
}

async function resolveAddressMetadataForArgs(
  chainId: number,
  params: ParamType[],
  rawArgs: unknown[] | undefined
): Promise<Record<string, AddressMetadata>> {
  if (!rawArgs || !rawArgs.length || !params.length) return {};

  const addresses = new Set<string>();
  params.forEach((param, index) => {
    collectAddressesFromParam(param, rawArgs[index], addresses);
  });

  if (!addresses.size) return {};

  let provider: ReturnType<typeof getProviderFor> | null = null;
  try {
    provider = getProviderFor(chainId);
  } catch (err) {
    logger.debug({ chainId, err }, "Failed to acquire provider for address metadata enrichment");
  }

  const metadataEntries = await Promise.all(
    Array.from(addresses).map(async (address) => {
      try {
        const info: AddressMetadata = await getAddressMetadata(address, chainId);

        if (provider) {
          try {
            const implementationAddr = await getImplementationAddress(provider, address);
            if (implementationAddr && implementationAddr !== address) {
              const implMeta = await getAddressMetadata(implementationAddr, chainId);
              info.implementation = {
                address: implementationAddr,
                contractName: implMeta.contractName,
                etherscanLabel: implMeta.etherscanLabel,
                tokenSymbol: implMeta.tokenSymbol,
                tokenName: implMeta.tokenName,
                tokenDecimals: implMeta.tokenDecimals,
                labels: implMeta.labels,
                ensName: implMeta.ensName,
              };
            }
          } catch (err) {
            logger.debug({ address, chainId, err }, "Failed to resolve proxy implementation for address argument");
          }
        }

        info.chainId = chainId;
        if (
          !info.contractName &&
          !info.etherscanLabel &&
          !info.tokenSymbol &&
          !info.implementation
        ) {
          // Still return a minimal entry if chainId differs from mainnet,
          // so the frontend uses the correct explorer for this address
          if (chainId !== 1) {
            return [address, info] as [string, AddressMetadata];
          }
          return null;
        }
        return [address, info] as [string, AddressMetadata];
      } catch (err) {
        logger.debug({ address, chainId, err }, "Failed to resolve metadata for address argument");
        return null;
      }
    })
  );

  const metadata: Record<string, AddressMetadata> = {};
  for (const entry of metadataEntries) {
    if (!entry) continue;
    metadata[entry[0]] = entry[1];
  }

  return metadata;
}

// pick selected args by name
function pickArgs(
  decoded: { argParams: ParamType[]; rawArgs: unknown[] },
  names: string[],
) {
  const set = new Set(names);
  const argParams: ParamType[] = [];
  const rawArgs: unknown[] = [];
  decoded.argParams.forEach((p, i) => {
    if (set.has(p.name)) {
      argParams.push(p);
      rawArgs.push(decoded.rawArgs[i]);
    }
  });
  return { argParams, rawArgs };
}

// ---------------------- Core decoding ----------------------

/**
 * Decode a single call on a given chainId.
 * - Decodes ABI (if available)
 * - Detects/expands children via registry (bridges, multicalls, etc.)
 * - Recurses into children with their own chainId
 */
async function decodeActionCall(
  ctx: {
    chainId: number;
    options?: DecoderOptions;
    actionIndex?: number;
    sigHint?: string;
    siblings?: SiblingCalls | undefined;
  },
  target: string,
  value: bigint,
  data: string
): Promise<CallNode> {
  const chainId = ctx.chainId;
  const options = ctx.options;
  const actionIndex = ctx.actionIndex ?? 0;
  const sigHint = ctx.sigHint;
  const siblings = ctx.siblings;
  const trackSources = options?.trackSources ?? false;
  const targetCS = checksum(target);
  logger.debug({ chainId, target, value, data, trackSources }, "Decoding action call");

  // Get contract name with source tracking if enabled
  let targetContractName: string | Sourced<string> | undefined;

  if (trackSources) {
    const nameSourced = await getContractNameWithSource(targetCS, chainId);
    if (nameSourced && nameSourced.value) {
      targetContractName = sourced(nameSourced.value, nameSourced.source);
    }
  } else {
    targetContractName = (await getContractName(targetCS, chainId)) ?? undefined;
  }

  // Track sources for proposal parameters: targets[i], values[i], calldatas[i]
  const node: CallNode = trackSources ? {
    chainId: sourced(chainId, hardcodedSource(
      "decoder.ts",
      chainId === 1 ? "Ethereum mainnet default" : "Bridge destination chain"
    )),
    target: sourced(targetCS, proposalParameterSource("targets", actionIndex, targetCS)),
    targetContractName,
    valueWei: sourced(value, proposalParameterSource("values", actionIndex, "0x" + value.toString(16).padStart(64, "0"))),
    rawCalldata: sourced(data, proposalParameterSource("calldatas", actionIndex, data)),
    notes: [],
  } : {
    chainId,
    target: targetCS,
    targetContractName,
    valueWei: value,
    rawCalldata: data,
    notes: [],
  };

  // Trivial case: no calldata at all
  if (!data || data === "0x") {
    node.notes!.push("empty calldata (possible ETH transfer or fallback)");
    logger.debug("Empty calldata, returning");
    return node;
  }

  // Try to decode using ABI for this chain
  let iface: Interface | undefined;
  let abiSource: DataSource | undefined;

  try {
    logger.debug(`Checking for proxy implementation for ${targetCS} on chain ${chainId}`);
    const provider = getProviderFor(chainId);
    const impl = await getImplementationAddress(provider, targetCS);
    if (impl && impl !== targetCS) {
      // It's a proxy - get implementation details
      if (trackSources) {
        const implNameSourced = await getContractNameWithSource(impl, chainId);
        node.implementation = sourced(impl, onChainSource(
          chainId,
          targetCS,
          "getImplementationAddress",
          [],
          `cast call ${targetCS} "implementation()(address)" --rpc-url $RPC_URL`
        ));
        if (implNameSourced?.value) {
          node.implementationContractName = sourced(implNameSourced.value, implNameSourced.source);
        }
        const abiResult = await getAbiForWithSource(impl, chainId);
        iface = abiResult?.iface;
        abiSource = abiResult?.source;
      } else {
        const implName = await getContractName(impl, chainId);
        node.implementation = impl;
        node.implementationContractName = implName || undefined;
        iface = (await getAbiFor(impl, chainId)) ?? undefined;
      }
      logger.debug({ proxy: targetCS, implementation: impl }, "Using implementation ABI");
    } else {
      logger.debug(`No proxy detected for ${targetCS} on chain ${chainId}`);
      if (trackSources) {
        const abiResult = await getAbiForWithSource(targetCS, chainId);
        iface = abiResult?.iface;
        abiSource = abiResult?.source;
      } else {
        iface = (await getAbiFor(targetCS, chainId)) ?? undefined;
      }
    }
  } catch (err: unknown) {
    logger.warn(
      err,
      `Error checking proxy for ${targetCS} on chain ${chainId}; falling back to target ABI`
    );
    if (trackSources) {
      const abiResult = await getAbiForWithSource(targetCS, chainId);
      iface = abiResult?.iface;
      abiSource = abiResult?.source;
    } else {
      iface = (await getAbiFor(targetCS, chainId)) ?? undefined;
    }
  }

  // Fallback: if the target ABI couldn't be fetched (e.g. Etherscan rate limit or an
  // unverified contract), but the call data carried a canonical signature hint
  // (Compound governance batches embed it), build a minimal Interface from the hint so
  // the function still decodes. This makes inner bridge/multicall decoding deterministic
  // and independent of remote ABI availability.
  if (!iface && sigHint) {
    try {
      iface = new Interface([`function ${sigHint}`]);
      abiSource = handlerSource("embedded-signature", `Signature from call data: ${sigHint}`);
      logger.debug({ target: targetCS, sigHint }, "Using embedded signature hint for ABI");
    } catch (err) {
      logger.debug({ sigHint, err }, "Failed to build interface from signature hint");
    }
  }

  if (iface) {
    let decoded = decodeWithInterface(iface, data, options, abiSource);
    // If the fetched ABI didn't contain this selector but we have an embedded
    // signature hint, retry with an interface derived from the hint.
    if (!decoded && sigHint) {
      try {
        const hintIface = new Interface([`function ${sigHint}`]);
        decoded = decodeWithInterface(
          hintIface,
          data,
          options,
          handlerSource("embedded-signature", `Signature from call data: ${sigHint}`)
        );
      } catch (err) {
        logger.debug({ sigHint, err }, "Failed to decode with signature hint");
      }
    }
    if (decoded) {
      node.decoded = decoded;
      const sigValue = typeof decoded.signature === "object" ? decoded.signature.value : decoded.signature;
      logger.debug({ signature: sigValue }, "Decoded function call");

      // Refine target contract name if this is a shared contract (e.g., Configurator)
      // and we can identify the market from a cometProxy argument
      const cometProxyHint = extractCometProxyHint(decoded);
      if (cometProxyHint) {
        const refinedLabel = getCometContractLabel(chainId, targetCS, cometProxyHint);
        if (refinedLabel && refinedLabel !== node.targetContractName) {
          logger.debug(
            { target: targetCS, oldName: node.targetContractName, newName: refinedLabel, hint: cometProxyHint },
            "Refined target name using cometProxy hint"
          );
          node.targetContractName = refinedLabel;
        }
      }
    }
  }

  // Ask the registry if this call should expand into children (bridge, multicall, etc.)
  const expansion = await registry.apply({
    chainId,
    target: targetCS,
    valueWei: value,
    rawCalldata: data,
    siblings,
    parsed: node.decoded
      ? {
          iface: iface as Interface,
          selector: unwrap(node.decoded.selector),
          name: unwrap(node.decoded.name),
          args: node.decoded.args,
        }
      : undefined,
    options, // Pass options to handlers
  });

  if (expansion.insights.length) {
    node.insights = expansion.insights.map((i) => i.insight);
  }

  if (expansion.children.length) {
    logger.debug({ count: expansion.children.length }, "Expanding children");
    node.children = [];
    // A bridged payload is itself an ordered, atomic batch, so children get the
    // same sibling view the top-level actions do.
    const childCalls = expansion.children.map((cr) => ({
      chainId: cr.nodeInput.chainId,
      target: cr.nodeInput.target,
      rawCalldata: cr.nodeInput.rawCalldata,
    }));
    for (const [childIndex, cr] of expansion.children.entries()) {
      const childNode = await decodeActionCall(
        {
          chainId: cr.nodeInput.chainId,
          options, // Pass options to recursive calls
          sigHint: cr.nodeInput.sigHint,
          siblings: { index: childIndex, calls: childCalls },
        },
        cr.nodeInput.target,
        cr.nodeInput.valueWei ?? 0n,
        cr.nodeInput.rawCalldata
      );
      node.children.push({ edge: cr.edge, node: childNode });
    }
  }

  // Resolve metadata possibly on a different chain for bridges or gateways
  let effectiveChainId = chainId;

  // Define bridge contracts and their special handling
  const BRIDGE_CONTRACTS = {
    '0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f': 'createRetryableTicket', // Arbitrum
    '0xd19d4B5d358258f05D7B411E21A1460D11B0876F': 'sendMessage', // Linea
    '0x9A3D64E386C18Cb1d6d5179a9596A4B5736e98A6': 'sendMessage', // Unichain
    '0x676A795fe6E43C17c668de16730c3F690FEB7120': 'sendMessage', // Mantle
    '0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1': 'sendMessage', // Optimism
    '0x6774Bcbd5ceCeF1336b5300fb5186a12DDD8b367': 'sendMessage', // Scroll
    '0x866E82a600A1414e583f7F13623F1aC5d58b0Afa': 'sendMessage', // Base
    '0xfe5e5D361b2ad62c541bAb87C45a0B9B018389a2': 'sendMessageToChild', // Polygon
    '0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D': 'ccipSend', // CCIP Router
  } as const;

  // Token gateways with fixed destination chain and arg roles
  const TOKEN_GATEWAYS: Record<string, {
    method: string;
    dstChainId: number;
    srcArgNames: string[];
    dstArgNames: string[];
  }> = {
     '0xA5874756416Fa632257eEA380CAbd2E87cED352A': {
       method: 'bridgeERC20To',
       dstChainId: 8453,
       srcArgNames: ['_localToken'],
       dstArgNames: ['_remoteToken', '_to'],
     },
     '0x504A330327A089d8364C4ab3811Ee26976d388ce': {
       method: 'depositTo',
       dstChainId: 59144,
       srcArgNames: [],
       dstArgNames: ['to'],
     },
     '0x051F1D88f0aF5763fB888eC4378b4D8B29ea3319': {
       method: 'bridgeToken',
       dstChainId: 59144,
       srcArgNames: ['_token'],
       dstArgNames: ['_recipient'],
     },
  };

  // Bridge detection to set effectiveChainId
  // Use unwrap() because node.decoded.name may be Sourced<string> when trackSources is enabled
  const decodedFnName = node.decoded?.name ? unwrap(node.decoded.name) : undefined;
  if (expansion.children.length && decodedFnName && targetCS) {
    const expectedMethod = BRIDGE_CONTRACTS[targetCS as keyof typeof BRIDGE_CONTRACTS];
    if (expectedMethod && decodedFnName === expectedMethod) {
      effectiveChainId = expansion.children[0].nodeInput.chainId;
      logger.debug({ effectiveChainId }, 'Detected bridge transaction');
    }
  }

  // Metadata enrichment path selection
  if (node.decoded) {
    const gw = TOKEN_GATEWAYS[targetCS as keyof typeof TOKEN_GATEWAYS];

    if (gw && decodedFnName === gw.method && node.decoded.rawArgs) {
      const srcPart = pickArgs(node.decoded as { argParams: ParamType[]; rawArgs: unknown[] }, gw.srcArgNames);
      const dstPart = pickArgs(node.decoded as { argParams: ParamType[]; rawArgs: unknown[] }, gw.dstArgNames);

      try {
        const [srcMeta, dstMeta] = await Promise.all([
          resolveAddressMetadataForArgs(chainId, srcPart.argParams, srcPart.rawArgs),
          resolveAddressMetadataForArgs(gw.dstChainId, dstPart.argParams, dstPart.rawArgs),
        ]);
        const merged = { ...srcMeta, ...dstMeta };
        if (Object.keys(merged).length) node.decoded.addressMetadata = merged;
      } catch (err) {
        logger.debug({ err, chainId, dstChainId: gw.dstChainId, target: targetCS }, "Failed token gateway enrichment");
      }
    } else {
      try {
        const addressMetadata = await resolveAddressMetadataForArgs(
          effectiveChainId,
          node.decoded.argParams,
          node.decoded.rawArgs
        );
        if (Object.keys(addressMetadata).length) {
          node.decoded.addressMetadata = addressMetadata;
        }
      } catch (err) {
        logger.debug({ err, chainId, target: targetCS }, "Failed to enrich address metadata");
      }
    }
  }

  if (!node.decoded) {
    // if zero selector, skip the warning about ABI
    if (selectorOf(data) === "0x00000000") {
      if (node.children) {
        node.notes!.push("zero selector; but handler decoded");
      } else {
        node.notes!.push("zero selector; cannot decode; you may need to implement a handler");
      }
    } else if (iface) {
      if (node.children) {
        node.notes!.push("unknown function selector; but handler decoded");
        logger.warn(
          { selector: selectorOf(data), target: targetCS },
          "Function selector not in ABI, but handler decoded"
        );
      } else {
        node.notes!.push(
          "unknown function selector; cannot decode; you may need to implement a new proxy detector or a handler"
        );
        logger.warn(
          { selector: selectorOf(data), target: targetCS },
          "Function selector not in ABI"
        );
      }
    } else {
      node.notes!.push("ABI not available (unverified or failed fetch); cannot decode selector");
      logger.warn({ address: targetCS }, "ABI not available");
    }
  }

  return node;
}

// ---------------------- Proposal driver ----------------------

export async function decodeProposalFromCalldata(
  calldata: string,
  options?: DecoderOptions
): Promise<DecodedProposal> {
  const proposeInterface = new Interface([
    "function propose(address[] targets, uint256[] amounts, bytes[] calldatas, string description)",
  ]);

  try {
    const decodedArgs = proposeInterface.decodeFunctionData("propose", calldata);

    const targets = decodedArgs.targets as string[];
    const values = decodedArgs.amounts as bigint[];
    const calldatas = decodedArgs.calldatas as string[];
    const description = decodedArgs.description as string;

    const descriptionHash = keccak256(toUtf8Bytes(description));

    const details: ProposalDetails = {
      targets,
      values,
      calldatas,
      descriptionHash,
    };

    logger.debug(details, "Decoded proposal details from calldata");

    return decodeProposalFromDetails(details, {}, options);
  } catch (error) {
    logger.error(error, "Failed to decode calldata");
    throw new Error(
      "Failed to decode calldata. Please ensure it is valid for `propose(address[],uint256[],bytes[],string)`."
    );
  }
}

export type ProposalMetadata = {
  governor?: string;
  proposalId?: bigint;
  chainId?: number;
};

export async function decodeProposalFromDetails(
  details: ProposalDetails,
  metadata: ProposalMetadata = {},
  options?: DecoderOptions
): Promise<DecodedProposal> {
  const chainId = metadata.chainId ?? ETHEREUM_MAINNET_CHAIN_ID;
  const governor = metadata.governor ? checksum(metadata.governor) : checksum(GOVERNOR_PROXY);
  const proposalId = metadata.proposalId ?? 0n;
  const trackSources = options?.trackSources ?? false;

  const { targets, values, calldatas, descriptionHash } = details;

  if (!(targets.length === values.length && values.length === calldatas.length)) {
    throw new Error("Proposal details arrays must have equal length");
  }

  const calls: CallNode[] = [];
  // Every action sees the whole action list, so a handler can account for state
  // an earlier action in this same proposal rewrites before its call runs.
  const siblingCalls = targets.map((target, i) => ({
    chainId,
    target: target!,
    rawCalldata: calldatas[i]!,
  }));
  for (let i = 0; i < targets.length; i++) {
    const node = await decodeActionCall(
      { chainId, options, actionIndex: i, siblings: { index: i, calls: siblingCalls } },
      targets[i]!,
      values[i]!,
      calldatas[i]!
    );
    calls.push(node);
  }

  if (trackSources) {
    return {
      governor: sourced(governor, hardcodedSource("decoder.ts", "Compound Governor Bravo proxy")),
      proposalId: sourced(proposalId, metadata.proposalId
        ? onChainSource(1, governor, "proposalDetails", [proposalId.toString()], `cast call ${governor} "proposals(uint256)" ${proposalId} --rpc-url $RPC_URL`)
        : hardcodedSource("decoder.ts", "Proposal ID from input")
      ),
      descriptionHash: sourced(descriptionHash, hardcodedSource("decoder.ts", "keccak256 hash of proposal description")),
      calls,
    };
  }

  return { governor, proposalId, descriptionHash, calls };
}

export async function decodeProposal(
  proposalIdNum: number,
  options?: DecoderOptions
): Promise<DecodedProposal> {
  logger.info(`Decoding proposal ${proposalIdNum}`);
  const provider = getProviderFor(ETHEREUM_MAINNET_CHAIN_ID);
  const governor = checksum(GOVERNOR_PROXY);
  const proposalId = BigInt(proposalIdNum);

  try {
    const details = await callProposalDetails(provider, governor, proposalId);
    logger.debug(details, "Got proposal details");

    const decoded = await decodeProposalFromDetails(details, { governor, proposalId }, options);
    logger.info("Finished decoding proposal");
    return decoded;
  } catch (err: unknown) {
    if (err instanceof Error && /execution reverted/.test(err.message)) {
      throw new Error(`Governor contract call reverted; ensure proposalId ${proposalId} exists`);
    }
    throw err;
  }
}

// Re-export types for consumers
export type {
  AddressMetadata,
  CallNode,
  DecodedFunction,
  DecodedProposal,
  ProposalDetails,
  SerializableParamInfo,
  DecoderOptions,
  DataSource,
  Sourced,
} from "./types.js";

// Re-export source tracking utilities
export {
  sourced,
  isSourced,
  unwrap,
  getSource,
  calldataSource,
  etherscanAbiSource,
  etherscanTagSource,
  etherscanSourcecodeSource,
  onChainSource,
  staticMetadataSource,
  handlerSource,
  externalApiSource,
  hardcodedSource,
  localAbiSource,
} from "./types/sources.js";

// Re-export sourced metadata types from ethers
export type {
  SourcedAddressMetadata,
  SourcedAddressMetadataMap,
  SourcedAbi,
  SourcedContractName,
} from "./ethers.js";

export { clearConfigCache } from "./config.js";