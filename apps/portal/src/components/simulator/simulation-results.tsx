"use client";

import { SimulationHeader } from "./simulation-header";
import { ChainResultCard } from "./chain-result-card";
import { getChainName } from "@/lib/chains";
import { groupChainResults } from "@/lib/chain-grouping";
import type { SerializedSimulationResult } from "@/types/simulator";

interface SimulationResultsProps {
  result: SerializedSimulationResult;
}

/** Arrow + label shown between cards to indicate what triggered what. */
function FlowConnector({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 pl-3 py-1">
      <div className="flex flex-col items-center gap-0.5 shrink-0">
        <div className="w-px h-2 bg-slate-300 rounded" />
        <div className="w-0 h-0 border-l-[4px] border-r-[4px] border-t-[5px] border-l-transparent border-r-transparent border-t-slate-300" />
      </div>
      <span className="text-xs text-slate-400 font-medium">{label}</span>
    </div>
  );
}

export function SimulationResults({ result }: SimulationResultsProps) {
  const { mainnetResults, l2Groups } = groupChainResults(result.chainResults);
  const hasHierarchy = l2Groups.length > 0;

  return (
    <div className="space-y-8" data-testid="simulation-results">
      <SimulationHeader result={result} />

      <div className="space-y-6">
        <h2 className="text-lg font-semibold text-slate-900">
          Chain Execution Results
        </h2>

        <div className="space-y-1">
          {/* L1 mainnet results */}
          {mainnetResults.map((r) => (
            <ChainResultCard key={r.chain} result={r} />
          ))}

          {/* L2 children of mainnet, each with their relay grandchildren */}
          {hasHierarchy && (
            <div className="ml-6 pl-4 border-l-2 border-slate-200 space-y-1">
              {l2Groups.map(({ l2, relays }, i) => (
                <div key={`${l2.chain}-${i}`}>
                  <FlowConnector label={`Bridge call → ${getChainName(l2.chainId)}`} />
                  <ChainResultCard result={l2} />

                  {relays.length > 0 && (
                    <div className="ml-6 pl-4 border-l-2 border-slate-200 space-y-1">
                      {relays.map((relay, j) => (
                        <div key={`${relay.chain}-${j}`}>
                          <FlowConnector label="Relay back → Ethereum" />
                          <ChainResultCard
                            result={relay}
                            displayName={`${getChainName(l2.chainId)} → Ethereum`}
                            isRelay
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Flat fallback: results that don't fit any pattern (no mainnet root) */}
          {!hasHierarchy && mainnetResults.length === 0 &&
            result.chainResults.map((r, i) => (
              <ChainResultCard key={`${r.chain}-${i}`} result={r} />
            ))}
        </div>
      </div>
    </div>
  );
}
