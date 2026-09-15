import { describe, it, expect } from "vitest";
import {
  getChainName,
  getChainColor,
  getChainTxGasLimit,
  CHAIN_NAMES,
  CHAIN_COLORS,
  CHAIN_TX_GAS_LIMITS,
} from "./chains";

describe("getChainName", () => {
  it("returns correct name for known chains", () => {
    expect(getChainName(1)).toBe("Ethereum");
    expect(getChainName(10)).toBe("Optimism");
    expect(getChainName(137)).toBe("Polygon");
    expect(getChainName(8453)).toBe("Base");
    expect(getChainName(42161)).toBe("Arbitrum");
    expect(getChainName(59144)).toBe("Linea");
    expect(getChainName(534352)).toBe("Scroll");
    expect(getChainName(5000)).toBe("Mantle");
    expect(getChainName(130)).toBe("Unichain");
    expect(getChainName(2020)).toBe("Ronin");
  });

  it("returns a fallback string for unknown chainId", () => {
    expect(getChainName(99999)).toBe("Chain 99999");
    expect(getChainName(0)).toBe("Chain 0");
  });

  it("covers every entry in CHAIN_NAMES", () => {
    for (const [id, name] of Object.entries(CHAIN_NAMES)) {
      expect(getChainName(Number(id))).toBe(name);
    }
  });
});

describe("getChainColor", () => {
  it("returns correct color for known chains", () => {
    expect(getChainColor(1)).toBe("gray");
    expect(getChainColor(10)).toBe("red");
    expect(getChainColor(8453)).toBe("blue");
    expect(getChainColor(42161)).toBe("blue");
    expect(getChainColor(59144)).toBe("green");
    expect(getChainColor(534352)).toBe("orange");
  });

  it("falls back to gray for unknown chainId", () => {
    expect(getChainColor(99999)).toBe("gray");
    expect(getChainColor(0)).toBe("gray");
  });

  it("covers every entry in CHAIN_COLORS", () => {
    for (const [id, color] of Object.entries(CHAIN_COLORS)) {
      expect(getChainColor(Number(id))).toBe(color);
    }
  });
});

describe("getChainTxGasLimit", () => {
  it("returns correct gas limit for known chains", () => {
    expect(getChainTxGasLimit(1)).toBe(16_000_000);
    expect(getChainTxGasLimit(10)).toBe(30_000_000);
    expect(getChainTxGasLimit(42161)).toBe(32_000_000);
    expect(getChainTxGasLimit(59144)).toBe(61_000_000);
    expect(getChainTxGasLimit(534352)).toBe(10_000_000);
  });

  it("returns undefined for unknown chainId", () => {
    expect(getChainTxGasLimit(99999)).toBeUndefined();
    expect(getChainTxGasLimit(0)).toBeUndefined();
  });

  it("covers every entry in CHAIN_TX_GAS_LIMITS", () => {
    for (const [id, limit] of Object.entries(CHAIN_TX_GAS_LIMITS)) {
      expect(getChainTxGasLimit(Number(id))).toBe(limit);
    }
  });
});
