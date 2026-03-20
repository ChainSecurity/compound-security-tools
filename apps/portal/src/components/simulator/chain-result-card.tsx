"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Globe, Fuel, ExternalLink, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TransactionExecution } from "./transaction-execution";

import { getChainName, getChainColor, getChainTxGasLimit } from "@/lib/chains";
import type { SerializedChainExecutionResult } from "@/types/simulator";

interface ChainResultCardProps {
  result: SerializedChainExecutionResult;
  defaultExpanded?: boolean;
}

/** 14,000,000 — transactions exceeding this on Ethereum are getting close to block limits */
const ETHEREUM_GAS_WARNING_THRESHOLD = 14_000_000;

/** 2^24 = 16,777,216 — transactions exceeding this on Ethereum are dangerously large */
const ETHEREUM_GAS_ALERT_THRESHOLD = 2 ** 24;

function formatGas(gas: string | undefined): string {
  if (!gas) return "N/A";
  const num = BigInt(gas);
  return num.toLocaleString();
}

function exceedsGasWarning(gas: string | undefined): boolean {
  if (!gas) return false;
  return BigInt(gas) > BigInt(ETHEREUM_GAS_WARNING_THRESHOLD);
}

function exceedsGasThreshold(gas: string | undefined): boolean {
  if (!gas) return false;
  return BigInt(gas) > BigInt(ETHEREUM_GAS_ALERT_THRESHOLD);
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// Get chain-specific background color
function getChainBgColor(color: string): string {
  const colorMap: Record<string, string> = {
    blue: "bg-blue-50",
    green: "bg-green-50",
    yellow: "bg-yellow-50",
    purple: "bg-purple-50",
    orange: "bg-orange-50",
    red: "bg-red-50",
    gray: "bg-slate-100",
  };
  return colorMap[color] ?? "bg-slate-100";
}

function getChainTextColor(color: string): string {
  const colorMap: Record<string, string> = {
    blue: "text-blue-600",
    green: "text-green-600",
    yellow: "text-yellow-600",
    purple: "text-purple-600",
    orange: "text-orange-600",
    red: "text-red-600",
    gray: "text-slate-600",
  };
  return colorMap[color] ?? "text-slate-600";
}

/**
 * Check if the RPC URL is a Tenderly virtual testnet URL
 */
function isTenderlyUrl(rpcUrl: string): boolean {
  try {
    const url = new URL(rpcUrl);
    return url.hostname.includes("tenderly.co");
  } catch {
    return false;
  }
}

export function ChainResultCard({ result, defaultExpanded = true }: ChainResultCardProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const chainName = getChainName(result.chainId);
  const chainColor = getChainColor(result.chainId);
  const txGasLimit = getChainTxGasLimit(result.chainId);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      {/* Header - Clickable */}
      <div
        className="p-6 cursor-pointer hover:bg-slate-50 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            {/* Expand/Collapse icon */}
            <div className="text-slate-400">
              {isExpanded ? (
                <ChevronDown className="w-5 h-5" />
              ) : (
                <ChevronRight className="w-5 h-5" />
              )}
            </div>

            {/* Chain icon */}
            <div className={`w-10 h-10 rounded-xl ${getChainBgColor(chainColor)} flex items-center justify-center`}>
              <Globe className={`w-5 h-5 ${getChainTextColor(chainColor)}`} />
            </div>

            {/* Chain name and status */}
            <div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-semibold text-slate-900">{chainName}</span>
                <Badge variant={result.success ? "green" : "orange"} className="text-xs">
                  {result.success ? "Success" : "Failed"}
                </Badge>
                {result.persisted && (
                  <Badge variant="gray" className="text-xs">
                    Persisted
                  </Badge>
                )}
              </div>
              <div className="text-sm text-slate-500 mt-0.5">
                {result.executions.length} transaction{result.executions.length !== 1 ? "s" : ""}
              </div>
            </div>
          </div>

          {/* Right side info */}
          <div className="flex items-center gap-4" onClick={(e) => e.stopPropagation()}>
            {result.totalGasUsed && (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Fuel className="w-4 h-4" />
                <span>{formatGas(result.totalGasUsed)}</span>
                {txGasLimit && (
                  <span className="text-slate-400" title={`Tx gas limit: ${txGasLimit.toLocaleString()}`}>
                    / {(txGasLimit / 1_000_000)}M
                  </span>
                )}
              </div>
            )}
            {!result.totalGasUsed && txGasLimit && (
              <div className="flex items-center gap-2 text-sm text-slate-400" title={`Tx gas limit: ${txGasLimit.toLocaleString()}`}>
                <Fuel className="w-4 h-4" />
                <span>Limit: {(txGasLimit / 1_000_000)}M</span>
              </div>
            )}
            {result.rpcUrl && isTenderlyUrl(result.rpcUrl) && (
              <a
                href={result.rpcUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 hover:underline"
                title="View on Tenderly"
              >
                <ExternalLink className="w-4 h-4" />
                <span>Tenderly</span>
              </a>
            )}
          </div>
        </div>

        {/* High gas warning for Ethereum (> 14M) */}
        {result.chainId === 1 && exceedsGasWarning(result.totalGasUsed) && !exceedsGasThreshold(result.totalGasUsed) && (
          <div
            className="mt-4 flex items-start gap-3 p-4 bg-amber-50 border-2 border-amber-300 rounded-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <AlertTriangle className="w-6 h-6 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <div className="text-base font-bold text-amber-700">
                Gas exceeds 14M ({ETHEREUM_GAS_WARNING_THRESHOLD.toLocaleString()})
              </div>
              <div className="text-sm text-amber-600 mt-1">
                This proposal uses {formatGas(result.totalGasUsed)} gas on Ethereum, which is getting close to block gas limits.
              </div>
            </div>
          </div>
        )}

        {/* High gas alert for Ethereum (> 2^24) */}
        {result.chainId === 1 && exceedsGasThreshold(result.totalGasUsed) && (
          <div
            className="mt-4 flex items-start gap-3 p-4 bg-red-50 border-2 border-red-300 rounded-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <AlertTriangle className="w-6 h-6 text-red-600 shrink-0 mt-0.5" />
            <div>
              <div className="text-base font-bold text-red-700">
                Gas exceeds 2^24 ({ETHEREUM_GAS_ALERT_THRESHOLD.toLocaleString()})
              </div>
              <div className="text-sm text-red-600 mt-1">
                This proposal uses {formatGas(result.totalGasUsed)} gas on Ethereum, which exceeds 2^24.
                This may be too large to execute in a single block and could fail on-chain.
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-slate-100 p-6 space-y-6">
          {/* Timelock address */}
          <div className="flex items-center gap-2 text-sm">
            <span className="text-slate-500">Timelock:</span>
            <code className="font-mono text-slate-700 bg-slate-50 px-2 py-0.5 rounded">
              {truncateAddress(result.timelockAddress)}
            </code>
          </div>

          {/* Transactions */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-700">Transactions</span>
              <span className="text-xs text-slate-400">({result.executions.length})</span>
            </div>
            <div className="space-y-3">
              {result.executions.map((tx) => (
                <TransactionExecution key={tx.index} tx={tx} chainId={result.chainId} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
