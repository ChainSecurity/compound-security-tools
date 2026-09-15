import { Interface, JsonRpcProvider } from "ethers";
import { checksum } from "@/utils";
import { getProviderFor } from "@/ethers";
import { insight, selectorOfSig, type Handler, type InsightRequest } from "@/registry";
import { logger } from "@/logger";
import { handlerSource } from "@/types/sources";

/**
 * `CometFactoryV2.setVersion(...)` (WOOF! Bytecode Repository) does not name the
 * implementation it will deploy: it selects a version tag, and the actual init code
 * is fetched from a separate BytecodeProvider at *execution* time by
 * `deployAndUpgradeTo` -> `Configurator.deploy` -> `factory.clone`.
 *
 * A reviewer reading the raw calldata only sees three small integers, so this handler
 * resolves the version tag into the facts that decide whether the upgrade is safe:
 * which provider supplies the code, whether that version is registered and
 * audit-verified, its init code hash, and the source URL / audit reports on record.
 *
 * It also flags the two ways this call reverts and takes the whole proposal with it:
 * the version already being set (`SameVersion`), and a non-timelock caller.
 */
const HANDLER_NAME = "comet-factory-version-handler";

const SET_VERSION_SIG = "setVersion(((uint64,uint64,uint64),string))";
const SET_VERSION_SELECTOR = selectorOfSig(SET_VERSION_SIG);

const FACTORY_ABI = [
  "function version() view returns ((uint64,uint64,uint64),string)",
  "function timelock() view returns (address)",
  "function bytecodeProvider() view returns (address)",
  "function COMET_CT() view returns (bytes32)",
];

const PROVIDER_ABI = [
  "function versionExists((bytes32,((uint64,uint64,uint64),string))) view returns (bool)",
  "function isBytecodeVerified((bytes32,((uint64,uint64,uint64),string))) view returns (bool)",
  "function getVerifiedInitCodeHash((bytes32,((uint64,uint64,uint64),string))) view returns (bytes32)",
  "function getAuditorsForBytecodeVersion((bytes32,((uint64,uint64,uint64),string))) view returns (address[])",
  "function getAuditReport((bytes32,((uint64,uint64,uint64),string)),address) view returns (string)",
  "function computeBytecodeHash(bytes32,((uint64,uint64,uint64),string)) view returns (bytes32)",
  "function bytecodes(bytes32) view returns (bytes32 contractType, bytes32 initCodeHash, string sourceURL, address author)",
];

type VersionTuple = { major: bigint; minor: bigint; patch: bigint; alternative: string };

function formatVersion(v: VersionTuple): string {
  return `${v.major}.${v.minor}.${v.patch}${v.alternative}`;
}

function bytes32ToLabel(value: string): string {
  try {
    const hex = value.startsWith("0x") ? value.slice(2) : value;
    const bytes = hex.replace(/(00)+$/, "");
    if (bytes.length === 0 || bytes.length % 2 !== 0) return value;
    const text = Buffer.from(bytes, "hex").toString("utf8");
    return /^[\x20-\x7e]+$/.test(text) ? text : value;
  } catch {
    return value;
  }
}

/** Parse the single dynamic struct argument out of the raw calldata. */
function parseNewVersion(rawCalldata: string): VersionTuple | null {
  try {
    const iface = new Interface([`function setVersion(((uint64,uint64,uint64),string))`]);
    const decoded = iface.decodeFunctionData("setVersion", rawCalldata);
    const [versionPart, alternative] = decoded[0] as unknown as [
      [bigint, bigint, bigint],
      string
    ];
    return {
      major: BigInt(versionPart[0]),
      minor: BigInt(versionPart[1]),
      patch: BigInt(versionPart[2]),
      alternative: String(alternative ?? ""),
    };
  } catch (err) {
    logger.debug({ err }, "Failed to decode setVersion calldata");
    return null;
  }
}

function getProviderSafe(chainId: number): JsonRpcProvider | null {
  try {
    return getProviderFor(chainId);
  } catch (err) {
    logger.debug({ chainId, err }, "Comet factory version insights skipped: missing provider");
    return null;
  }
}

async function readContract<T>(
  provider: JsonRpcProvider,
  address: string,
  iface: Interface,
  fn: string,
  args: unknown[] = []
): Promise<T | null> {
  try {
    const data = iface.encodeFunctionData(fn, args);
    const raw = await provider.call({ to: address, data });
    const decoded = iface.decodeFunctionResult(fn, raw);
    return (decoded.length === 1 ? decoded[0] : decoded) as T;
  } catch (err) {
    logger.debug({ address, fn, err }, "Comet factory version: call failed");
    return null;
  }
}

export const cometFactoryVersionHandler: Handler = {
  name: "Comet factory version insights",
  match: (ctx) => {
    if (!ctx.rawCalldata || ctx.rawCalldata.length < 10) return false;
    return ctx.rawCalldata.slice(0, 10) === SET_VERSION_SELECTOR;
  },
  expand: async (ctx) => {
    const insights: InsightRequest[] = [];
    const newVersion = parseNewVersion(ctx.rawCalldata);
    if (!newVersion) return insights;

    const factory = checksum(ctx.target);
    const entries: Array<{ label: string; value: string }> = [
      { label: "Factory", value: factory },
      { label: "New Version", value: formatVersion(newVersion) },
    ];

    const provider = getProviderSafe(ctx.chainId);
    if (!provider) {
      entries.push({
        label: "Status",
        value: "No RPC configured — could not verify the version is registered or audited",
      });
      insights.push(
        insight({
          title: "Comet Factory Version Update (No RPC)",
          entries,
          _handlerSource: handlerSource(HANDLER_NAME),
        })
      );
      return insights;
    }

    const factoryIface = new Interface(FACTORY_ABI);

    const current = await readContract<[[bigint, bigint, bigint], string]>(
      provider,
      factory,
      factoryIface,
      "version"
    );
    if (current) {
      const currentVersion: VersionTuple = {
        major: BigInt(current[0][0]),
        minor: BigInt(current[0][1]),
        patch: BigInt(current[0][2]),
        alternative: String(current[1] ?? ""),
      };
      entries.splice(1, 0, { label: "Current Version", value: formatVersion(currentVersion) });

      // The factory rejects a no-op update, which would revert the entire proposal.
      if (
        currentVersion.major === newVersion.major &&
        currentVersion.minor === newVersion.minor &&
        currentVersion.patch === newVersion.patch &&
        currentVersion.alternative === newVersion.alternative
      ) {
        entries.push({
          label: "⚠️ WILL REVERT",
          value:
            "Factory is already at this version — setVersion reverts with SameVersion(), reverting the whole proposal. This happens if an identical proposal already executed.",
        });
      } else if (
        newVersion.major !== currentVersion.major &&
        newVersion.major !== currentVersion.major + 1n
      ) {
        entries.push({
          label: "⚠️ WILL REVERT",
          value: `Major version must be incremental (${currentVersion.major} -> ${
            currentVersion.major + 1n
          }); reverts with OnlyIterativeUpdate().`,
        });
      } else if (newVersion.major === currentVersion.major && newVersion.minor < currentVersion.minor) {
        entries.push({
          label: "⚠️ WILL REVERT",
          value: "Minor version cannot decrease; reverts with InvalidMinorVersion().",
        });
      }
    }

    const timelock = await readContract<string>(provider, factory, factoryIface, "timelock");
    if (timelock) {
      entries.push({
        label: "Factory timelock (only caller allowed)",
        value: checksum(timelock),
      });
    }

    const contractType = await readContract<string>(provider, factory, factoryIface, "COMET_CT");
    const providerAddr = await readContract<string>(provider, factory, factoryIface, "bytecodeProvider");

    if (!providerAddr || !contractType) {
      entries.push({
        label: "Status",
        value: "Target does not expose bytecodeProvider()/COMET_CT() — not a CometFactoryV2?",
      });
      insights.push(
        insight({
          title: "Factory Version Update",
          entries,
          _handlerSource: handlerSource(HANDLER_NAME),
        })
      );
      return insights;
    }

    entries.push(
      { label: "Contract Type", value: `${bytes32ToLabel(contractType)}` },
      { label: "Bytecode Provider", value: checksum(providerAddr) }
    );

    const providerIface = new Interface(PROVIDER_ABI);
    const versionArg = [
      contractType,
      [[newVersion.major, newVersion.minor, newVersion.patch], newVersion.alternative],
    ];

    const exists = await readContract<boolean>(provider, providerAddr, providerIface, "versionExists", [
      versionArg,
    ]);
    entries.push({
      label: "Version registered",
      value:
        exists === null
          ? "unknown (call failed)"
          : exists
          ? "✓ yes"
          : "✗ NO — setVersion reverts with NonExistingVersion()",
    });

    const verified = await readContract<boolean>(
      provider,
      providerAddr,
      providerIface,
      "isBytecodeVerified",
      [versionArg]
    );
    entries.push({
      label: "Audit-verified",
      value:
        verified === null
          ? "unknown (call failed)"
          : verified
          ? "✓ yes"
          : "✗ NO — deploy reverts (getVerifiedBytecode requires a verified bytecode)",
    });

    if (verified) {
      const initCodeHash = await readContract<string>(
        provider,
        providerAddr,
        providerIface,
        "getVerifiedInitCodeHash",
        [versionArg]
      );
      if (initCodeHash) {
        entries.push({ label: "Init Code Hash", value: initCodeHash });
      }

      const versionHash = await readContract<string>(
        provider,
        providerAddr,
        providerIface,
        "computeBytecodeHash",
        [contractType, [[newVersion.major, newVersion.minor, newVersion.patch], newVersion.alternative]]
      );
      if (versionHash) {
        const record = await readContract<unknown>(provider, providerAddr, providerIface, "bytecodes", [
          versionHash,
        ]);
        if (Array.isArray(record)) {
          const sourceURL = String(record[2] ?? "");
          const author = record[3] ? checksum(String(record[3])) : null;
          if (sourceURL) {
            entries.push({
              label: "Registered Source",
              value: `${sourceURL}\n(review THIS commit — it is what gets deployed, not necessarily the PR head)`,
            });
          }
          if (author) entries.push({ label: "Key Developer", value: author });
        }
      }

      const auditors = await readContract<string[]>(
        provider,
        providerAddr,
        providerIface,
        "getAuditorsForBytecodeVersion",
        [versionArg]
      );
      if (Array.isArray(auditors) && auditors.length > 0) {
        for (const auditor of auditors) {
          const report = await readContract<string>(
            provider,
            providerAddr,
            providerIface,
            "getAuditReport",
            [versionArg, auditor]
          );
          entries.push({
            label: `Audit (${checksum(auditor)})`,
            value: report ? String(report) : "(no report URL on record)",
          });
        }
      }
    }

    entries.push({
      label: "Effect",
      value:
        "Selects which init code the factory deploys. The code is fetched from the Bytecode Provider at EXECUTION time, so what gets deployed depends on the provider's state then, not now.",
    });

    insights.push(
      insight({
        title: "Comet Factory Version Update (Bytecode Repository)",
        entries,
        _handlerSource: handlerSource(
          HANDLER_NAME,
          "Read factory version/timelock/provider and the provider's registration + audit records on-chain"
        ),
      })
    );

    return insights;
  },
};
