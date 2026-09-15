import type { SerializedChainExecutionResult } from "@/types/simulator";

export type L2Group = {
  l2: SerializedChainExecutionResult;
  relays: SerializedChainExecutionResult[];
};

export type ChainGroupResult = {
  mainnetResults: SerializedChainExecutionResult[];
  l2Groups: L2Group[];
};

/**
 * Group the flat chainResults list into a tree:
 *   mainnet → [ l2 → [ relay, … ], … ]
 *
 * The simulator emits results in order: L2 result, then its relays, then the
 * next L2 result. We use positional grouping (relay attaches to the most
 * recently seen L2) rather than chain-name grouping, so two bridge calls to
 * the same chain (e.g. two Optimism executions) are kept separate.
 *
 * Relay results are identified by "→" in their chain field (e.g. "base→mainnet").
 */
export function groupChainResults(chainResults: SerializedChainExecutionResult[]): ChainGroupResult {
  const mainnetResults: SerializedChainExecutionResult[] = [];
  const l2Groups: L2Group[] = [];

  for (const result of chainResults) {
    if (result.chain === "mainnet") {
      mainnetResults.push(result);
    } else if (result.chain.includes("→")) {
      if (l2Groups.length > 0) {
        l2Groups[l2Groups.length - 1]!.relays.push(result);
      } else {
        // Orphan relay with no preceding L2 result — surface it as its own entry
        l2Groups.push({ l2: result, relays: [] });
      }
    } else {
      l2Groups.push({ l2: result, relays: [] });
    }
  }

  return { mainnetResults, l2Groups };
}
