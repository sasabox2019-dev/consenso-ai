import type { ConsensusMetrics } from "@consenso/shared";
import { useI18n } from "../i18n";

const AGREEMENT_COLOR: Record<ConsensusMetrics["agreement_level"], string> = {
  HIGH: "text-good",
  MODERATE: "text-warn",
  LOW: "text-bad",
};

export default function MetricsBar({ metrics }: { metrics: ConsensusMetrics }) {
  const { t } = useI18n();
  const items = [
    { label: t("metrics_confidence"), value: `${metrics.confidence}%`, bar: metrics.confidence },
    {
      label: t("metrics_agreement"),
      value: metrics.agreement_level,
      bar:
        metrics.agreement_level === "HIGH" ? 85 : metrics.agreement_level === "MODERATE" ? 55 : 25,
      valueClass: AGREEMENT_COLOR[metrics.agreement_level],
    },
    { label: t("metrics_time"), value: `${metrics.processing_time_s}s`, bar: null },
    {
      label: t("metrics_agents"),
      value: `${metrics.agents_ok}/${metrics.agents_total}`,
      bar: null,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((it) => (
        <div key={it.label} className="rounded-xl border border-edge bg-void/50 p-3">
          <div className="mono-label mb-1">{it.label}</div>
          <div className={`font-mono text-lg ${it.valueClass ?? "text-ink"}`}>{it.value}</div>
          {it.bar !== null && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-edge">
              <div
                className="h-full rounded-full bg-gradient-to-r from-cyan to-violet transition-all duration-700"
                style={{ width: `${Math.min(100, it.bar)}%` }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
