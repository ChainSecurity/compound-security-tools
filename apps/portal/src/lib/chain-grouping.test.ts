import { describe, it, expect } from "vitest";
import { groupChainResults } from "./chain-grouping";
import type { SerializedChainExecutionResult } from "@/types/simulator";

// ── Fixture helper ───────────────────────────────────────────────────────────

function makeResult(chain: string, chainId = 1): SerializedChainExecutionResult {
  return {
    chain,
    chainId,
    success: true,
    timelockAddress: "0x" + "00".repeat(20),
    executions: [],
    persisted: false,
  };
}

// ── Basic grouping ───────────────────────────────────────────────────────────

describe("groupChainResults", () => {
  it("returns empty groups for empty input", () => {
    const { mainnetResults, l2Groups } = groupChainResults([]);
    expect(mainnetResults).toHaveLength(0);
    expect(l2Groups).toHaveLength(0);
  });

  it("places mainnet results into mainnetResults", () => {
    const { mainnetResults, l2Groups } = groupChainResults([makeResult("mainnet")]);
    expect(mainnetResults).toHaveLength(1);
    expect(mainnetResults[0]!.chain).toBe("mainnet");
    expect(l2Groups).toHaveLength(0);
  });

  it("places L2 results into l2Groups", () => {
    const { mainnetResults, l2Groups } = groupChainResults([
      makeResult("mainnet"),
      makeResult("optimism", 10),
    ]);
    expect(mainnetResults).toHaveLength(1);
    expect(l2Groups).toHaveLength(1);
    expect(l2Groups[0]!.l2.chain).toBe("optimism");
    expect(l2Groups[0]!.relays).toHaveLength(0);
  });

  it("attaches a relay to the preceding L2 group", () => {
    const { l2Groups } = groupChainResults([
      makeResult("mainnet"),
      makeResult("optimism", 10),
      makeResult("optimism→mainnet", 1),
    ]);
    expect(l2Groups).toHaveLength(1);
    expect(l2Groups[0]!.relays).toHaveLength(1);
    expect(l2Groups[0]!.relays[0]!.chain).toBe("optimism→mainnet");
  });

  it("attaches multiple relays to the same L2 group", () => {
    const { l2Groups } = groupChainResults([
      makeResult("base", 8453),
      makeResult("base→mainnet", 1),
      makeResult("base→mainnet", 1),
    ]);
    expect(l2Groups).toHaveLength(1);
    expect(l2Groups[0]!.relays).toHaveLength(2);
  });

  // ── The bug that triggered this test: two calls to the same chain ────────────

  it("keeps two bridge calls to the same chain in separate groups (prop 580 regression)", () => {
    const { l2Groups } = groupChainResults([
      makeResult("mainnet"),
      makeResult("optimism", 10),   // first call
      makeResult("optimism→mainnet", 1),
      makeResult("optimism", 10),   // second call
      makeResult("optimism→mainnet", 1),
    ]);
    expect(l2Groups).toHaveLength(2);
    expect(l2Groups[0]!.l2.chain).toBe("optimism");
    expect(l2Groups[0]!.relays).toHaveLength(1);
    expect(l2Groups[1]!.l2.chain).toBe("optimism");
    expect(l2Groups[1]!.relays).toHaveLength(1);
  });

  it("handles mixed L2 chains correctly", () => {
    const { l2Groups } = groupChainResults([
      makeResult("mainnet"),
      makeResult("optimism", 10),
      makeResult("optimism→mainnet", 1),
      makeResult("base", 8453),
      makeResult("arbitrum", 42161),
    ]);
    expect(l2Groups).toHaveLength(3);
    expect(l2Groups[0]!.l2.chain).toBe("optimism");
    expect(l2Groups[0]!.relays).toHaveLength(1);
    expect(l2Groups[1]!.l2.chain).toBe("base");
    expect(l2Groups[1]!.relays).toHaveLength(0);
    expect(l2Groups[2]!.l2.chain).toBe("arbitrum");
  });

  it("handles multiple mainnet results", () => {
    const { mainnetResults } = groupChainResults([
      makeResult("mainnet"),
      makeResult("mainnet"),
    ]);
    expect(mainnetResults).toHaveLength(2);
  });

  it("handles proposal with no mainnet result (direct L2 only)", () => {
    const { mainnetResults, l2Groups } = groupChainResults([
      makeResult("optimism", 10),
    ]);
    expect(mainnetResults).toHaveLength(0);
    expect(l2Groups).toHaveLength(1);
  });

  // ── Orphan relay ─────────────────────────────────────────────────────────────

  it("surfaces an orphan relay (relay with no preceding L2 result) as its own group", () => {
    const { l2Groups } = groupChainResults([
      makeResult("mainnet"),
      makeResult("optimism→mainnet", 1),
    ]);
    expect(l2Groups).toHaveLength(1);
    expect(l2Groups[0]!.l2.chain).toBe("optimism→mainnet");
    expect(l2Groups[0]!.relays).toHaveLength(0);
  });

  // ── Chain count (header stat) ─────────────────────────────────────────────

  it("allows counting unique chains by filtering out relays and deduplicating chainIds", () => {
    const results = [
      makeResult("mainnet", 1),
      makeResult("optimism", 10),
      makeResult("optimism→mainnet", 1),
      makeResult("optimism", 10),
      makeResult("base", 8453),
    ];
    const uniqueChains = new Set(
      results.filter(r => !r.chain.includes("→")).map(r => r.chainId)
    ).size;
    expect(uniqueChains).toBe(3); // mainnet, optimism, base
  });
});
