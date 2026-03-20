"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, Copy, Check, ExternalLink, AlertTriangle, FileText, Circle, CheckCircle2 } from "lucide-react";
import { FunctionDetails } from "./function-details";
import { InsightCard } from "./insight-card";
import { ChainBadge } from "./chain-badge";
import type { SerializedCallNode, SourcedSerializedCallNode, CallEdge, Sourced } from "@/types/decoder";
import { isSourced, unwrap } from "@/types/decoder";
import { SourceTooltip } from "@/components/ui/source-tooltip";

interface ActionCardProps {
  node: SerializedCallNode | SourcedSerializedCallNode;
  index: number;
  total: number;
  edge?: CallEdge;
  depth?: number;
  id?: string;
  defaultExpanded?: boolean;
  reviewedIds?: Set<string>;
  onToggleReviewed?: (id: string) => void;
}

// Helper to get the value from a potentially sourced value
function getValue<T>(val: T | Sourced<T>): T {
  return isSourced(val) ? val.value : val;
}

type FormattedValue = {
  display: string;
  isZero: boolean;
};

function formatValue(valueWei: string | Sourced<string>): FormattedValue {
  try {
    const weiStr = getValue(valueWei);
    const value = BigInt(weiStr);
    if (value === 0n) return { display: "No Value", isZero: true };
    const eth = Number(value) / 1e18;
    const display = eth >= 0.0001 ? `${eth.toFixed(4)} ETH` : `${weiStr} wei`;
    return { display, isZero: false };
  } catch {
    return { display: "No Value", isZero: true };
  }
}

function getExplorerUrl(address: string, chainId: number): string {
  const explorers: Record<number, string> = {
    1: "https://etherscan.io",
    10: "https://optimistic.etherscan.io",
    130: "https://uniscan.xyz",
    137: "https://polygonscan.com",
    2020: "https://app.roninchain.com",
    5000: "https://mantlescan.xyz",
    8453: "https://basescan.org",
    42161: "https://arbiscan.io",
    59144: "https://lineascan.build",
    534352: "https://scrollscan.com",
  };
  return `${explorers[chainId] ?? "https://etherscan.io"}/address/${address}`;
}

// Clickable address that toggles between truncated and full
function ClickableAddress({
  address,
  chainId,
  source
}: {
  address: string;
  chainId: number;
  source?: import("@/types/decoder").DataSource;
}) {
  const [showFull, setShowFull] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const truncated = `${address.slice(0, 6)}...${address.slice(-4)}`;

  const copyAddress = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const addressDisplay = (
    <button
      onClick={() => setShowFull(!showFull)}
      className="font-mono text-sm text-slate-500 hover:text-slate-700 transition-colors"
      title={showFull ? "Click to truncate" : "Click to show full address"}
    >
      {showFull ? address : truncated}
    </button>
  );

  return (
    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {source ? (
        <SourceTooltip source={source}>{addressDisplay}</SourceTooltip>
      ) : (
        addressDisplay
      )}
      <button
        onClick={copyAddress}
        className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-slate-600 transition-colors"
        title="Copy address"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
      <a
        href={getExplorerUrl(address, chainId)}
        target="_blank"
        rel="noopener noreferrer"
        className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-slate-600 transition-colors"
        title="View on explorer"
      >
        <ExternalLink className="w-3.5 h-3.5" />
      </a>
    </div>
  );
}

// Generate markdown for an action
function generateMarkdown(node: SerializedCallNode | SourcedSerializedCallNode, depth: number = 0): string {
  const indent = "  ".repeat(depth);
  const rawCalldata = getValue(node.rawCalldata);
  const selector = rawCalldata?.slice(0, 10);
  const isZeroSelector = selector === "0x00000000" || rawCalldata === "0x" || !rawCalldata || rawCalldata.length < 10;
  const isFallbackCall = isZeroSelector && !node.decoded?.name;
  const functionName = node.decoded?.name
    ? getValue(node.decoded.name)
    : isFallbackCall
      ? "Fallback / Receive"
      : "Unknown Function";
  const contractNameValue = getValue(node.targetContractName ?? "");
  const targetValue = getValue(node.target);

  let md = `${indent}### ${functionName}\n`;
  md += `${indent}- **Target**: \`${targetValue}\`${contractNameValue ? ` (${contractNameValue})` : ""}\n`;
  md += `${indent}- **Chain**: ${node.chainId}\n`;

  if (node.decoded?.signature) {
    md += `${indent}- **Signature**: \`${node.decoded.signature}\`\n`;
  }

  if (node.decoded?.args && node.decoded.args.length > 0) {
    md += `${indent}- **Arguments**:\n`;
    node.decoded.args.forEach((arg, i) => {
      const paramName = node.decoded?.argParamInfo?.[i]?.name || `arg${i}`;
      const argValue = isSourced(arg) ? arg.value : arg;
      md += `${indent}  - ${paramName}: \`${JSON.stringify(argValue)}\`\n`;
    });
  }

  if (node.children && node.children.length > 0) {
    md += `\n${indent}#### Nested Calls\n`;
    node.children.forEach((child) => {
      md += generateMarkdown(child.node, depth + 1);
    });
  }

  return md;
}

export function ActionCard({ node, index, total, edge, depth = 0, id, defaultExpanded = true, reviewedIds, onToggleReviewed }: ActionCardProps) {
  const [isOpen, setIsOpen] = React.useState(defaultExpanded);
  const [copiedMd, setCopiedMd] = React.useState(false);

  // Sync with defaultExpanded prop
  React.useEffect(() => {
    setIsOpen(defaultExpanded);
  }, [defaultExpanded]);

  const reviewed = !!(id && reviewedIds?.has(id));
  const hasChildren = node.children && node.children.length > 0;
  const hasNotes = node.notes && node.notes.length > 0;
  const hasInsights = node.insights && node.insights.length > 0;
  const valueInfo = formatValue(node.valueWei);
  const valueSource = isSourced(node.valueWei) ? node.valueWei.source : undefined;

  // Determine function name - check for fallback (zero selector) vs unknown
  const rawCalldata = getValue(node.rawCalldata);
  const selector = rawCalldata?.slice(0, 10); // "0x" + 4 bytes = 10 chars
  const isZeroSelector = selector === "0x00000000" || rawCalldata === "0x" || !rawCalldata || rawCalldata.length < 10;
  const isFallbackCall = isZeroSelector && !node.decoded?.name;

  const functionName = node.decoded?.name
    ? getValue(node.decoded.name)
    : isFallbackCall
      ? "Fallback / Receive"
      : "Unknown Function";
  const functionNameSource = node.decoded?.name && isSourced(node.decoded.name)
    ? node.decoded.name.source
    : node.decoded?.signature && isSourced(node.decoded.signature)
      ? node.decoded.signature.source
      : undefined;
  const targetValue = getValue(node.target);
  const targetMetadata = node.decoded?.addressMetadata?.[targetValue];
  const targetContractNameRaw = targetMetadata?.contractName ?? node.targetContractName;
  const contractName = getValue(targetContractNameRaw ?? "");
  const contractNameSource = isSourced(targetContractNameRaw) ? targetContractNameRaw.source : undefined;

  const copyAsMarkdown = (e: React.MouseEvent) => {
    e.stopPropagation();
    const md = generateMarkdown(node);
    navigator.clipboard.writeText(md);
    setCopiedMd(true);
    setTimeout(() => setCopiedMd(false), 2000);
  };

  const isNested = depth > 0;

  const handleToggleReviewed = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (id && onToggleReviewed) onToggleReviewed(id);
  };

  return (
    <div id={id} data-testid={id} className={`rounded-2xl border transition-colors ${
      reviewed
        ? "border-emerald-200"
        : "border-slate-200"
    }`}>
      {/* Header */}
      <div
        className={`p-6 cursor-pointer transition-colors ${isOpen ? "rounded-t-2xl" : "rounded-2xl"} sticky top-14 z-10 ${reviewed ? "bg-emerald-50/30 hover:bg-emerald-100/40" : "bg-white hover:bg-slate-50"}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-start gap-4">
          {/* Expand icon */}
          <div className="mt-1 text-slate-400">
            {isOpen ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Top row - metadata */}
            <div className="flex items-center gap-3 mb-3 flex-wrap">
              {!isNested && (
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Action {index} of {total}
                </span>
              )}
              {edge && (
                edge._source || isSourced(edge.label) || isSourced(edge.type) ? (
                  <SourceTooltip source={edge._source ?? (isSourced(edge.label) ? edge.label.source : isSourced(edge.type) ? edge.type.source : edge._source!)}>
                    <span className="px-2 py-1 rounded-md bg-slate-100 text-slate-700 text-xs font-medium">
                      {getValue(edge.label) ?? getValue(edge.type)}
                    </span>
                  </SourceTooltip>
                ) : (
                  <span className="px-2 py-1 rounded-md bg-slate-100 text-slate-700 text-xs font-medium">
                    {getValue(edge.label) ?? getValue(edge.type)}
                  </span>
                )
              )}
              {isSourced(node.chainId) ? (
                <SourceTooltip source={node.chainId.source}>
                  <span><ChainBadge chainId={node.chainId.value} /></span>
                </SourceTooltip>
              ) : (
                <ChainBadge chainId={node.chainId} />
              )}
              {valueSource ? (
                <SourceTooltip source={valueSource}>
                  <span className={`px-2 py-1 rounded-md text-xs font-medium cursor-help ${
                    valueInfo.isZero
                      ? "bg-slate-100 text-slate-500"
                      : "bg-amber-50 text-amber-700"
                  }`}>
                    {valueInfo.display}
                  </span>
                </SourceTooltip>
              ) : (
                <span className={`px-2 py-1 rounded-md text-xs font-medium ${
                  valueInfo.isZero
                    ? "bg-slate-100 text-slate-500"
                    : "bg-amber-50 text-amber-700"
                }`}>
                  {valueInfo.display}
                </span>
              )}
            </div>

            {/* Function name */}
            <h3 className="text-xl font-semibold text-slate-900 mb-1">
              {functionNameSource ? (
                <SourceTooltip source={functionNameSource}>
                  <span className="cursor-help">{functionName}</span>
                </SourceTooltip>
              ) : (
                functionName
              )}
            </h3>

            {/* Contract info */}
            <div className="flex items-center gap-3 flex-wrap">
              {contractName && (
                contractNameSource ? (
                  <SourceTooltip source={contractNameSource}>
                    <span className="text-slate-600 cursor-help">{contractName}</span>
                  </SourceTooltip>
                ) : (
                  <span className="text-slate-600">{contractName}</span>
                )
              )}
              <ClickableAddress
                address={targetValue}
                chainId={getValue(node.chainId)}
                source={isSourced(node.target) ? node.target.source : undefined}
              />
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={copyAsMarkdown}
              className="p-2 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-600 transition-colors"
              title="Copy as markdown"
            >
              {copiedMd ? <Check className="w-4 h-4 text-emerald-500" /> : <FileText className="w-4 h-4" />}
            </button>
            {onToggleReviewed && id && (
              <button
                onClick={handleToggleReviewed}
                className={`p-2 rounded-lg transition-colors ${
                  reviewed
                    ? "text-emerald-500 hover:bg-emerald-100"
                    : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                }`}
                title={reviewed ? "Mark as not reviewed" : "Mark as reviewed"}
              >
                {reviewed ? <CheckCircle2 className="w-5 h-5" /> : <Circle className="w-5 h-5" />}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Expanded Content */}
      {isOpen && (
        <div className={`border-t rounded-b-2xl ${reviewed ? "border-emerald-100 bg-emerald-50/30" : "border-slate-100 bg-white"}`}>
          <div className="p-6 space-y-8">
            {/* Implementation */}
            {node.implementation && (
              <div className="flex items-center gap-3 text-sm">
                <span className="text-slate-500">Implementation:</span>
                <ClickableAddress
                  address={getValue(node.implementation)}
                  chainId={getValue(node.chainId)}
                  source={isSourced(node.implementation) ? node.implementation.source : undefined}
                />
                {node.implementationContractName && (
                  isSourced(node.implementationContractName) ? (
                    <SourceTooltip source={node.implementationContractName.source}>
                      <span className="text-slate-500">({node.implementationContractName.value})</span>
                    </SourceTooltip>
                  ) : (
                    <span className="text-slate-500">({node.implementationContractName})</span>
                  )
                )}
              </div>
            )}

            {/* Function Details */}
            {node.decoded && (
              <FunctionDetails decoded={node.decoded} chainId={getValue(node.chainId)} />
            )}

            {/* Raw calldata */}
            {!node.decoded && node.rawCalldata && getValue(node.rawCalldata) !== "0x" && (
              <div>
                <h4 className="text-sm font-semibold text-slate-700 mb-3">Raw Calldata</h4>
                {isSourced(node.rawCalldata) ? (
                  <SourceTooltip source={node.rawCalldata.source}>
                    <code className="block text-xs font-mono text-slate-500 bg-slate-50 rounded-xl p-4 break-all cursor-help">
                      {node.rawCalldata.value.length > 200 ? `${node.rawCalldata.value.slice(0, 200)}...` : node.rawCalldata.value}
                    </code>
                  </SourceTooltip>
                ) : (
                  <code className="block text-xs font-mono text-slate-500 bg-slate-50 rounded-xl p-4 break-all">
                    {getValue(node.rawCalldata).length > 200 ? `${getValue(node.rawCalldata).slice(0, 200)}...` : getValue(node.rawCalldata)}
                  </code>
                )}
              </div>
            )}

            {/* Warnings */}
            {hasNotes && (
              <div className="space-y-3">
                {node.notes!.map((note, idx) => (
                  <SourceTooltip
                    key={idx}
                    source={{ type: "handler", handlerName: "decoder", description: "Generated during decoding analysis" }}
                  >
                    <div className="flex items-start gap-3 bg-amber-50 rounded-xl p-4 cursor-help">
                      <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                      <p className="text-sm text-amber-800">{note}</p>
                    </div>
                  </SourceTooltip>
                ))}
              </div>
            )}

            {/* Insights */}
            {hasInsights && (
              <div className="space-y-4">
                <h4 className="text-sm font-semibold text-slate-700">Insights</h4>
                <div className="grid gap-4">
                  {node.insights!.map((insight, idx) => (
                    <InsightCard key={idx} insight={insight} />
                  ))}
                </div>
              </div>
            )}

            {/* Nested Calls */}
            {hasChildren && (
              <div className="space-y-4">
                <h4 className="text-sm font-semibold text-slate-700">
                  Nested Calls ({node.children!.length})
                </h4>
                <div className="space-y-4">
                  {node.children!.map((child, idx) => (
                    <ActionCard
                      key={idx}
                      node={child.node}
                      edge={child.edge}
                      index={idx + 1}
                      total={node.children!.length}
                      depth={depth + 1}
                      id={id ? `${id}-${idx}` : undefined}
                      defaultExpanded={defaultExpanded}
                      reviewedIds={reviewedIds}
                      onToggleReviewed={onToggleReviewed}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
