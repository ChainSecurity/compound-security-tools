import { Interface, JsonRpcProvider } from "ethers";
import { checksum } from "@/utils";
import { logger } from "@/logger";
import { listCometMetadata } from "@/lib/comet-metadata";

/**
 * `deployAndUpgradeTo` redeploys the Comet implementation from the Configurator's
 * stored configuration, using whatever CometFactory the Configurator currently
 * holds for that market. The configuration diff in `comet-config-drift` therefore
 * only tells half the story: a redeploy also picks up any change to the factory
 * itself (a new factory address, or — for `CometFactoryV2` — a new bytecode
 * version), which changes the implementation *code* while every parameter stays
 * identical.
 *
 * Proposal 603 is exactly that case: four markets were redeployed before the
 * factory's bytecode version was bumped, so they sit on older code than their
 * siblings while their configuration matches perfectly.
 *
 * This module surfaces the factory in use, its version when the factory exposes
 * one, and a size fingerprint of the live implementation compared against the
 * sibling markets that share the same Configurator and factory. Comet bakes its
 * whole asset list into immutables, so every market built from one version has
 * the same runtime code length regardless of how many assets it lists — a size
 * mismatch against the siblings is a reliable "this market is on different code"
 * signal.
 */

/** EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1 */
const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const CONFIGURATOR_ABI = ["function factory(address cometProxy) view returns (address)"];
const FACTORY_V2_ABI = [
  "function version() view returns (tuple(uint64 major,uint64 minor,uint64 patch) version, string alternative)",
];

export interface CometImplVersion {
  /** CometFactory the Configurator will build the new implementation with. */
  factory?: string;
  /** Semver reported by `CometFactoryV2.version()`; absent on legacy factories. */
  factoryVersion?: string;
  /** Implementation the Comet proxy points at today. */
  liveImpl?: string;
  /** Runtime code length of `liveImpl`, in bytes. */
  liveCodeSize?: number;
  /** Sibling markets on this chain sharing the same Configurator and factory. */
  peerCount: number;
  /** How many of those peers run the `peerCodeSize` baseline. */
  peerAgreeing?: number;
  /** Runtime code length most of the peers share, when a majority agrees. */
  peerCodeSize?: number;
  /** True when the live implementation is a different size from its peers'. */
  differsFromPeers?: boolean;
  /** Set when the comparison could not be completed. */
  error?: string;
}

async function readAddress(
  provider: JsonRpcProvider,
  to: string,
  abi: string[],
  fn: string,
  args: unknown[] = []
): Promise<string | null> {
  try {
    const iface = new Interface(abi);
    const raw = await provider.call({ to, data: iface.encodeFunctionData(fn, args) });
    return checksum(iface.decodeFunctionResult(fn, raw)[0] as string);
  } catch (err) {
    logger.debug({ to, fn, err }, "comet-impl-version: call failed");
    return null;
  }
}

async function readImplSlot(provider: JsonRpcProvider, proxy: string): Promise<string | null> {
  try {
    const raw = await provider.getStorage(proxy, EIP1967_IMPL_SLOT);
    const impl = checksum(`0x${raw.slice(-40)}`);
    return impl === checksum("0x".padEnd(42, "0")) ? null : impl;
  } catch (err) {
    logger.debug({ proxy, err }, "comet-impl-version: failed to read EIP-1967 impl slot");
    return null;
  }
}

async function codeSize(provider: JsonRpcProvider, address: string): Promise<number | null> {
  try {
    const code = await provider.getCode(address);
    return (code.length - 2) / 2;
  } catch (err) {
    logger.debug({ address, err }, "comet-impl-version: getCode failed");
    return null;
  }
}

async function readFactoryVersion(
  provider: JsonRpcProvider,
  factory: string
): Promise<string | undefined> {
  try {
    const iface = new Interface(FACTORY_V2_ABI);
    const raw = await provider.call({ to: factory, data: iface.encodeFunctionData("version", []) });
    const [semver, alternative] = iface.decodeFunctionResult("version", raw) as unknown as [
      { major: bigint; minor: bigint; patch: bigint },
      string,
    ];
    const base = `${semver.major}.${semver.minor}.${semver.patch}`;
    return alternative ? `${base} (${alternative})` : base;
  } catch {
    // Legacy CometFactory has no version(); not an error.
    return undefined;
  }
}

/**
 * Describe the code the next `deployAndUpgradeTo` will produce for `cometProxy`,
 * relative to the implementation it runs today.
 */
export async function getCometImplVersion(
  provider: JsonRpcProvider,
  chainId: number,
  configuratorProxy: string,
  cometProxy: string
): Promise<CometImplVersion> {
  const [factory, liveImpl] = await Promise.all([
    readAddress(provider, configuratorProxy, CONFIGURATOR_ABI, "factory", [cometProxy]),
    readImplSlot(provider, cometProxy),
  ]);

  if (!factory) {
    return { peerCount: 0, error: "could not read Configurator.factory()" };
  }

  const result: CometImplVersion = {
    factory,
    liveImpl: liveImpl ?? undefined,
    peerCount: 0,
  };

  const [factoryVersion, liveCodeSize] = await Promise.all([
    readFactoryVersion(provider, factory),
    liveImpl ? codeSize(provider, liveImpl) : Promise.resolve(null),
  ]);
  result.factoryVersion = factoryVersion;
  result.liveCodeSize = liveCodeSize ?? undefined;

  if (liveCodeSize === null) return result;

  // Peers: other markets on this chain wired to the same Configurator, keeping
  // only those the Configurator builds with the same factory.
  const peers = listCometMetadata(chainId).filter(
    (meta) =>
      checksum(meta.configuratorAddress) === checksum(configuratorProxy) &&
      checksum(meta.cometAddress) !== checksum(cometProxy)
  );

  const peerSizes: number[] = [];
  for (const peer of peers) {
    const peerFactory = await readAddress(provider, configuratorProxy, CONFIGURATOR_ABI, "factory", [
      peer.cometAddress,
    ]);
    if (peerFactory !== factory) continue;
    const peerImpl = await readImplSlot(provider, peer.cometAddress);
    if (!peerImpl) continue;
    const size = await codeSize(provider, peerImpl);
    if (size !== null) peerSizes.push(size);
  }

  result.peerCount = peerSizes.length;
  if (peerSizes.length === 0) return result;

  // The baseline is the size most peers agree on. A bare plurality proves
  // nothing, so require a strict majority before calling the live code stale —
  // when a version bump is only half rolled out, several peers are stale too.
  const tally = new Map<number, number>();
  for (const size of peerSizes) tally.set(size, (tally.get(size) ?? 0) + 1);
  const [baseline, agreeing] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  if (agreeing * 2 <= peerSizes.length) return result;

  result.peerCodeSize = baseline;
  result.peerAgreeing = agreeing;
  result.differsFromPeers = liveCodeSize !== baseline;
  return result;
}
