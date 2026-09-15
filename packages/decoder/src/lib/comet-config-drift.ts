import { Interface, JsonRpcProvider, formatUnits } from "ethers";
import { checksum } from "@/utils";
import { logger } from "@/logger";

/**
 * `deployAndUpgradeTo` does not take any parameters describing the new market
 * configuration: it redeploys the Comet implementation from whatever the
 * Configurator currently holds. Any `set*` call that landed in the Configurator
 * earlier and was never followed by a redeploy is therefore applied silently by
 * the next upgrade, whoever proposes it.
 *
 * This module diffs the Configurator's stored configuration against the values
 * baked into the live Comet implementation, so a review can see exactly what an
 * upgrade carries beyond the setters in the proposal itself.
 */

const CONFIGURATOR_ABI = [
  "function getConfiguration(address cometProxy) view returns (tuple(address governor,address pauseGuardian,address baseToken,address baseTokenPriceFeed,address extensionDelegate,uint64 supplyKink,uint64 supplyPerYearInterestRateSlopeLow,uint64 supplyPerYearInterestRateSlopeHigh,uint64 supplyPerYearInterestRateBase,uint64 borrowKink,uint64 borrowPerYearInterestRateSlopeLow,uint64 borrowPerYearInterestRateSlopeHigh,uint64 borrowPerYearInterestRateBase,uint64 storeFrontPriceFactor,uint64 trackingIndexScale,uint64 baseTrackingSupplySpeed,uint64 baseTrackingBorrowSpeed,uint104 baseMinForRewards,uint104 baseBorrowMin,uint104 targetReserves,tuple(address asset,address priceFeed,uint8 decimals,uint64 borrowCollateralFactor,uint64 liquidateCollateralFactor,uint64 liquidationFactor,uint128 supplyCap)[] assetConfigs))",
];

const COMET_ABI = [
  "function governor() view returns (address)",
  "function pauseGuardian() view returns (address)",
  "function baseToken() view returns (address)",
  "function baseTokenPriceFeed() view returns (address)",
  "function extensionDelegate() view returns (address)",
  "function supplyKink() view returns (uint64)",
  "function supplyPerSecondInterestRateSlopeLow() view returns (uint64)",
  "function supplyPerSecondInterestRateSlopeHigh() view returns (uint64)",
  "function supplyPerSecondInterestRateBase() view returns (uint64)",
  "function borrowKink() view returns (uint64)",
  "function borrowPerSecondInterestRateSlopeLow() view returns (uint64)",
  "function borrowPerSecondInterestRateSlopeHigh() view returns (uint64)",
  "function borrowPerSecondInterestRateBase() view returns (uint64)",
  "function storeFrontPriceFactor() view returns (uint64)",
  "function trackingIndexScale() view returns (uint64)",
  "function baseTrackingSupplySpeed() view returns (uint64)",
  "function baseTrackingBorrowSpeed() view returns (uint64)",
  "function baseMinForRewards() view returns (uint104)",
  "function baseBorrowMin() view returns (uint104)",
  "function targetReserves() view returns (uint104)",
  "function numAssets() view returns (uint8)",
  "function getAssetInfo(uint8 i) view returns (tuple(uint8 offset,address asset,address priceFeed,uint64 scale,uint64 borrowCollateralFactor,uint64 liquidateCollateralFactor,uint64 liquidationFactor,uint128 supplyCap))",
];

/** Comet's SECONDS_PER_YEAR, used to convert the Configurator's per-year rates. */
const SECONDS_PER_YEAR = 31_536_000n;

export interface ConfigDrift {
  /** Human-readable lines, one per differing field. Empty means no drift. */
  changes: string[];
  /** Set when the comparison could not be completed. */
  error?: string;
}

function pct(value: bigint): string {
  return `${formatUnits(value * 100n, 18)}%`;
}

type Reader = (name: string) => Promise<bigint | string>;

function makeReader(provider: JsonRpcProvider, comet: string): Reader {
  const iface = new Interface(COMET_ABI);
  return async (name: string) => {
    const raw = await provider.call({ to: comet, data: iface.encodeFunctionData(name, []) });
    const [value] = iface.decodeFunctionResult(name, raw);
    return typeof value === "string" ? checksum(value) : (value as bigint);
  };
}

/**
 * Compare the Configurator's stored configuration for `cometProxy` against the
 * live implementation's values.
 *
 * Interest rates need care: the Configurator stores per-year rates and the
 * Comet constructor divides them by `SECONDS_PER_YEAR` (truncating), so the
 * per-second value read back from the market cannot be compared to the stored
 * per-year value directly. We apply the same truncation before comparing, which
 * makes this diff exact rather than approximate.
 */
export async function getCometConfigDrift(
  provider: JsonRpcProvider,
  configuratorProxy: string,
  cometProxy: string
): Promise<ConfigDrift> {
  let config: Record<string, unknown> & { assetConfigs: unknown[] };
  try {
    const iface = new Interface(CONFIGURATOR_ABI);
    const raw = await provider.call({
      to: configuratorProxy,
      data: iface.encodeFunctionData("getConfiguration", [cometProxy]),
    });
    [config] = iface.decodeFunctionResult("getConfiguration", raw) as unknown as [typeof config];
  } catch (err) {
    logger.debug({ configuratorProxy, cometProxy, err }, "Config drift: getConfiguration failed");
    return { changes: [], error: "could not read Configurator.getConfiguration()" };
  }

  const read = makeReader(provider, cometProxy);
  const changes: string[] = [];

  const addresses: Array<[string, string]> = [
    ["governor", "governor"],
    ["pauseGuardian", "pauseGuardian"],
    ["baseToken", "baseToken"],
    ["baseTokenPriceFeed", "baseTokenPriceFeed"],
    ["extensionDelegate", "extensionDelegate"],
  ];
  const scalars: Array<[string, string]> = [
    ["supplyKink", "supplyKink"],
    ["borrowKink", "borrowKink"],
    ["storeFrontPriceFactor", "storeFrontPriceFactor"],
    ["trackingIndexScale", "trackingIndexScale"],
    ["baseTrackingSupplySpeed", "baseTrackingSupplySpeed"],
    ["baseTrackingBorrowSpeed", "baseTrackingBorrowSpeed"],
    ["baseMinForRewards", "baseMinForRewards"],
    ["baseBorrowMin", "baseBorrowMin"],
    ["targetReserves", "targetReserves"],
  ];
  // Configurator field -> live per-second getter. Truncated by SECONDS_PER_YEAR.
  const rates: Array<[string, string]> = [
    ["supplyPerYearInterestRateSlopeLow", "supplyPerSecondInterestRateSlopeLow"],
    ["supplyPerYearInterestRateSlopeHigh", "supplyPerSecondInterestRateSlopeHigh"],
    ["supplyPerYearInterestRateBase", "supplyPerSecondInterestRateBase"],
    ["borrowPerYearInterestRateSlopeLow", "borrowPerSecondInterestRateSlopeLow"],
    ["borrowPerYearInterestRateSlopeHigh", "borrowPerSecondInterestRateSlopeHigh"],
    ["borrowPerYearInterestRateBase", "borrowPerSecondInterestRateBase"],
  ];

  try {
    for (const [field, getter] of addresses) {
      const stored = checksum(config[field] as string);
      const live = (await read(getter)) as string;
      if (stored !== live) changes.push(`${field}: ${live} → ${stored}`);
    }
    for (const [field, getter] of scalars) {
      const stored = config[field] as bigint;
      const live = (await read(getter)) as bigint;
      if (stored !== live) changes.push(`${field}: ${live} → ${stored}`);
    }
    for (const [field, getter] of rates) {
      const stored = (config[field] as bigint) / SECONDS_PER_YEAR;
      const live = (await read(getter)) as bigint;
      if (stored !== live) {
        changes.push(
          `${field}: ${pct(live * SECONDS_PER_YEAR)}/yr → ${pct(config[field] as bigint)}/yr`
        );
      }
    }
  } catch (err) {
    logger.debug({ cometProxy, err }, "Config drift: reading live Comet params failed");
    return { changes, error: "could not read every live Comet parameter" };
  }

  // Asset configs: additions, removals, and per-asset parameter changes.
  try {
    const numAssets = Number((await read("numAssets")) as bigint);
    const iface = new Interface(COMET_ABI);
    const liveAssets: Array<Record<string, unknown>> = [];
    for (let i = 0; i < numAssets; i++) {
      const raw = await provider.call({
        to: cometProxy,
        data: iface.encodeFunctionData("getAssetInfo", [i]),
      });
      const [info] = iface.decodeFunctionResult("getAssetInfo", raw) as unknown as [
        Record<string, unknown>,
      ];
      liveAssets.push(info);
    }

    const stored = config.assetConfigs as Array<Record<string, unknown>>;
    for (const asset of stored) {
      const address = checksum(asset.asset as string);
      const live = liveAssets.find((a) => checksum(a.asset as string) === address);
      if (!live) {
        changes.push(`asset ADDED: ${address}`);
        continue;
      }
      const diffs: string[] = [];
      if (checksum(asset.priceFeed as string) !== checksum(live.priceFeed as string)) {
        diffs.push(`priceFeed ${checksum(live.priceFeed as string)} → ${checksum(asset.priceFeed as string)}`);
      }
      for (const field of [
        "borrowCollateralFactor",
        "liquidateCollateralFactor",
        "liquidationFactor",
      ] as const) {
        if ((asset[field] as bigint) !== (live[field] as bigint)) {
          diffs.push(`${field} ${pct(live[field] as bigint)} → ${pct(asset[field] as bigint)}`);
        }
      }
      if ((asset.supplyCap as bigint) !== (live.supplyCap as bigint)) {
        diffs.push(`supplyCap ${(live.supplyCap as bigint).toString()} → ${(asset.supplyCap as bigint).toString()}`);
      }
      if (diffs.length) changes.push(`asset ${address}: ${diffs.join(", ")}`);
    }
    for (const live of liveAssets) {
      const address = checksum(live.asset as string);
      if (!stored.some((a) => checksum(a.asset as string) === address)) {
        changes.push(`asset REMOVED: ${address}`);
      }
    }
  } catch (err) {
    logger.debug({ cometProxy, err }, "Config drift: reading live asset configs failed");
    return { changes, error: "could not read every live asset config" };
  }

  return { changes };
}
