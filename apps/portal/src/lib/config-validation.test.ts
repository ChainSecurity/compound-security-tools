import { describe, it, expect } from "vitest";
import {
  validateChainConfig,
  validateConfig,
  getChainStatus,
  sortWarnings,
  groupWarningsBySeverity,
  hasFieldPlaceholder,
} from "./config-validation";
import type { AppConfig, ChainConfig } from "@/types/config";

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeChain(overrides: Partial<ChainConfig> = {}): ChainConfig {
  return {
    chainId: 1,
    rpcUrl: "https://eth.llamarpc.com",
    directory: "mainnet",
    timelockAddress: "0x6d903f6003cca6255D85CcA4D3B5E5146dC33925",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    etherscanApiKey: "ABCDEFGHIJKLMNOPQRST",
    chains: {
      mainnet: makeChain(),
    },
    defaults: {
      gas: "0x1C9C380",
      gasPrice: "0x0",
      robinhood: "0x9AA835Bc7b8cE13B9B0C9764A52FbF71AC62cCF1",
      COMP: "0xc00e94Cb662C3520282E6f5717214004A7f26888",
    },
    ...overrides,
  };
}

// ── validateChainConfig ──────────────────────────────────────────────────────

describe("validateChainConfig", () => {
  it("returns no warnings for a fully configured chain", () => {
    expect(validateChainConfig("mainnet", makeChain())).toHaveLength(0);
  });

  it("errors when rpcUrl is missing", () => {
    const warnings = validateChainConfig("mainnet", makeChain({ rpcUrl: "" }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ severity: "error", field: "rpcUrl", chain: "mainnet" });
  });

  it("errors when rpcUrl contains a placeholder", () => {
    const placeholders = [
      "https://your-rpc-here.com",       // matches /your-/
      "https://example.com/rpc",          // matches /example\.com/
      "https://placeholder.rpc.io",       // matches /placeholder/
      "https://<your-rpc>.io",            // matches /<your-/
      "https://get-rpc-here",             // matches /-here$/
    ];
    for (const url of placeholders) {
      const warnings = validateChainConfig("mainnet", makeChain({ rpcUrl: url }));
      const rpcWarning = warnings.find(w => w.field === "rpcUrl");
      expect(rpcWarning?.severity, `expected error for "${url}"`).toBe("error");
    }
  });

  it("warns when timelockAddress is missing", () => {
    const warnings = validateChainConfig("arbitrum", makeChain({ timelockAddress: undefined }));
    expect(warnings.some(w => w.severity === "warning" && w.field === "timelockAddress")).toBe(true);
  });

  it("attaches the chain name to every warning", () => {
    const warnings = validateChainConfig("base", makeChain({ rpcUrl: "" }));
    expect(warnings.every(w => w.chain === "base")).toBe(true);
  });
});

// ── validateConfig ───────────────────────────────────────────────────────────

describe("validateConfig", () => {
  it("returns no warnings for a valid config", () => {
    expect(validateConfig(makeConfig())).toHaveLength(0);
  });

  it("errors when etherscanApiKey is missing", () => {
    const warnings = validateConfig(makeConfig({ etherscanApiKey: "" }));
    expect(warnings.some(w => w.severity === "error" && w.field === "etherscanApiKey")).toBe(true);
  });

  it("errors when etherscanApiKey is a placeholder", () => {
    const warnings = validateConfig(makeConfig({ etherscanApiKey: "your-api-key-here" }));
    expect(warnings.some(w => w.severity === "error" && w.field === "etherscanApiKey")).toBe(true);
  });

  it("warns when robinhood address is missing", () => {
    const config = makeConfig();
    config.defaults.robinhood = "";
    const warnings = validateConfig(config);
    expect(warnings.some(w => w.severity === "warning" && w.field === "defaults.robinhood")).toBe(true);
  });

  it("warns when COMP address is missing", () => {
    const config = makeConfig();
    config.defaults.COMP = "";
    const warnings = validateConfig(config);
    expect(warnings.some(w => w.severity === "warning" && w.field === "defaults.COMP")).toBe(true);
  });

  it("propagates chain-level warnings", () => {
    const config = makeConfig({
      chains: { mainnet: makeChain({ rpcUrl: "" }) },
    });
    const warnings = validateConfig(config);
    expect(warnings.some(w => w.field === "rpcUrl" && w.chain === "mainnet")).toBe(true);
  });

  it("collects warnings from multiple chains", () => {
    const config = makeConfig({
      chains: {
        mainnet: makeChain({ rpcUrl: "" }),
        arbitrum: makeChain({ rpcUrl: "" }),
      },
    });
    const warnings = validateConfig(config);
    const rpcWarnings = warnings.filter(w => w.field === "rpcUrl");
    expect(rpcWarnings).toHaveLength(2);
  });

  it("returns no warnings for empty chains object", () => {
    const warnings = validateConfig(makeConfig({ chains: {} }));
    // Only potential defaults warnings
    expect(warnings.filter(w => w.field === "rpcUrl")).toHaveLength(0);
  });
});

// ── getChainStatus ───────────────────────────────────────────────────────────

describe("getChainStatus", () => {
  it("returns 'configured' when rpc and timelock are both set", () => {
    expect(getChainStatus(makeChain())).toBe("configured");
  });

  it("returns 'partial' when only rpc is set", () => {
    expect(getChainStatus(makeChain({ timelockAddress: undefined }))).toBe("partial");
  });

  it("returns 'partial' when only timelock is set", () => {
    expect(getChainStatus(makeChain({ rpcUrl: "" }))).toBe("partial");
  });

  it("returns 'not-configured' when neither is set", () => {
    expect(getChainStatus(makeChain({ rpcUrl: "", timelockAddress: undefined }))).toBe("not-configured");
  });

  it("returns 'partial' when rpc is a placeholder but timelock is set", () => {
    // A placeholder rpc counts as "no rpc", but timelock still configured → partial
    expect(getChainStatus(makeChain({ rpcUrl: "https://your-rpc-here.com" }))).toBe("partial");
  });

  it("returns 'not-configured' when both rpc is placeholder and timelock is missing", () => {
    expect(getChainStatus(makeChain({ rpcUrl: "https://your-rpc-here.com", timelockAddress: undefined }))).toBe("not-configured");
  });
});

// ── sortWarnings ─────────────────────────────────────────────────────────────

describe("sortWarnings", () => {
  it("sorts errors before warnings before info", () => {
    const input = [
      { severity: "info" as const, field: "f", message: "m" },
      { severity: "error" as const, field: "f", message: "m" },
      { severity: "warning" as const, field: "f", message: "m" },
    ];
    const sorted = sortWarnings(input);
    expect(sorted.map(w => w.severity)).toEqual(["error", "warning", "info"]);
  });

  it("is stable within same severity", () => {
    const input = [
      { severity: "error" as const, field: "a", message: "m" },
      { severity: "error" as const, field: "b", message: "m" },
    ];
    const sorted = sortWarnings(input);
    expect(sorted[0]!.field).toBe("a");
    expect(sorted[1]!.field).toBe("b");
  });

  it("does not mutate the original array", () => {
    const input = [
      { severity: "warning" as const, field: "f", message: "m" },
      { severity: "error" as const, field: "f", message: "m" },
    ];
    const copy = [...input];
    sortWarnings(input);
    expect(input).toEqual(copy);
  });

  it("handles an empty array", () => {
    expect(sortWarnings([])).toEqual([]);
  });
});

// ── groupWarningsBySeverity ──────────────────────────────────────────────────

describe("groupWarningsBySeverity", () => {
  it("groups warnings into the three severity buckets", () => {
    const input = [
      { severity: "error" as const, field: "a", message: "m" },
      { severity: "warning" as const, field: "b", message: "m" },
      { severity: "info" as const, field: "c", message: "m" },
      { severity: "error" as const, field: "d", message: "m" },
    ];
    const grouped = groupWarningsBySeverity(input);
    expect(grouped.error).toHaveLength(2);
    expect(grouped.warning).toHaveLength(1);
    expect(grouped.info).toHaveLength(1);
  });

  it("returns empty arrays for missing severities", () => {
    const grouped = groupWarningsBySeverity([]);
    expect(grouped.error).toHaveLength(0);
    expect(grouped.warning).toHaveLength(0);
    expect(grouped.info).toHaveLength(0);
  });
});

// ── hasFieldPlaceholder ──────────────────────────────────────────────────────

describe("hasFieldPlaceholder", () => {
  it("detects placeholder patterns", () => {
    expect(hasFieldPlaceholder("your-api-key")).toBe(true);
    expect(hasFieldPlaceholder("<your-rpc>")).toBe(true);
    expect(hasFieldPlaceholder("key-here")).toBe(true);
    expect(hasFieldPlaceholder("https://example.com")).toBe(true);
    expect(hasFieldPlaceholder("placeholder-value")).toBe(true);
  });

  it("returns false for real-looking values", () => {
    expect(hasFieldPlaceholder("ABCDEFGHIJKLMNOP")).toBe(false);
    expect(hasFieldPlaceholder("https://eth.llamarpc.com")).toBe(false);
    expect(hasFieldPlaceholder("0x6d903f6003cca6255D85CcA4D3B5E5146dC33925")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(hasFieldPlaceholder(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasFieldPlaceholder("")).toBe(false);
  });
});
