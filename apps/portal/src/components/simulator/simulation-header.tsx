import { CheckCircle, XCircle, Zap, Clock, Globe } from "lucide-react";
import type { SerializedSimulationResult } from "@/types/simulator";

interface SimulationHeaderProps {
  result: SerializedSimulationResult;
}

export function SimulationHeader({ result }: SimulationHeaderProps) {
  const durationSeconds = (result.durationMs / 1000).toFixed(1);

  // Determine overall status
  const allSuccess = result.chainResults.every((r) => r.success);
  const someSuccess = result.chainResults.some((r) => r.success);
  const statusText = allSuccess ? "Success" : someSuccess ? "Partial" : "Failed";
  const StatusIcon = result.success ? CheckCircle : XCircle;

  // Format mode display
  const modeDisplay = {
    governance: "Governance",
    direct: "Direct",
    "direct-persist": "Direct + Persist",
  }[result.mode] || result.mode;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" data-testid="simulation-header">
      {/* Status */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
            result.success ? "bg-emerald-50" : "bg-orange-50"
          }`}>
            <StatusIcon className={`w-5 h-5 ${
              result.success ? "text-emerald-600" : "text-orange-600"
            }`} />
          </div>
          <span className="text-sm font-medium text-slate-500">Status</span>
        </div>
        <div className="text-2xl font-bold text-slate-900" data-testid="simulation-status">
          {statusText}
        </div>
      </div>

      {/* Mode */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-purple-50 flex items-center justify-center">
            <Zap className="w-5 h-5 text-purple-600" />
          </div>
          <span className="text-sm font-medium text-slate-500">Mode</span>
        </div>
        <div className="text-2xl font-bold text-slate-900">
          {modeDisplay}
        </div>
      </div>

      {/* Duration */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
            <Clock className="w-5 h-5 text-amber-600" />
          </div>
          <span className="text-sm font-medium text-slate-500">Duration</span>
        </div>
        <div className="text-2xl font-bold text-slate-900">
          {durationSeconds}s
        </div>
      </div>

      {/* Chains */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center">
            <Globe className="w-5 h-5 text-blue-600" />
          </div>
          <span className="text-sm font-medium text-slate-500">Chains</span>
        </div>
        <div className="text-2xl font-bold text-slate-900">
          {new Set(result.chainResults.filter((r) => !r.chain.includes("→")).map((r) => r.chainId)).size}
        </div>
      </div>
    </div>
  );
}
