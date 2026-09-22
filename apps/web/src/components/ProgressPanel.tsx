import type { PublicAgent } from "@consenso/shared";
import { useI18n } from "../i18n";

export interface StageState {
  status: "active" | "done";
  fallback?: boolean;
}

export interface AgentRunState {
  status: "ok" | "error";
  confidence?: number;
  duration_ms?: number;
  error?: string;
}

interface Props {
  stages: Record<string, StageState>;
  agents: Record<string, AgentRunState>;
  participants: PublicAgent[];
  done: boolean;
  rounds: number;
}

export default function ProgressPanel({ stages, agents, participants, done, rounds }: Props) {
  const { t } = useI18n();
  const stagesList: Array<{ id: string; label: string; round?: number }> = [
    ...Array.from({ length: rounds }, (_, i) => ({
      id: `round${i + 1}`,
      label: i === 0 ? t("stage_round1") : `${t("stage_round2").replace("2", String(i + 1))}`,
      round: i + 1,
    })),
    { id: "moderation", label: t("stage_moderation") },
  ];
  return (
    <section className="panel p-4" aria-live="polite">
      <div className="mb-3 flex items-center gap-2">
        {!done && <span className="pulse-dot" />}
        <span className="mono-label">{done ? t("result_title") : t("running")}</span>
      </div>
      <div className="space-y-3">
        {stagesList.map((s) => {
          const state = stages[s.id];
          const isActive = state?.status === "active";
          const isDone = state?.status === "done";
          const roundAgents =
            s.round === undefined
              ? []
              : participants.map((p) => ({ p, state: agents[`${s.round}:${p.key}`] }));
          return (
            <div key={s.id}>
              <div className="flex items-center gap-2">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    isDone ? "bg-good" : isActive ? "bg-cyan" : "bg-edge"
                  }`}
                />
                <span
                  className={`text-xs ${isDone ? "text-good" : isActive ? "text-cyan" : "text-dim/60"}`}
                >
                  {s.label}
                  {s.round === undefined && state?.fallback ? " · ⚠" : ""}
                </span>
                {isActive && !isDone && <span className="stage-line ml-2 w-16 rounded-full" />}
              </div>
              {roundAgents.length > 0 && (
                <div className="ml-4 mt-1.5 flex flex-wrap gap-1.5">
                  {roundAgents.map(({ p, state }) => (
                    <span
                      key={`${s.round}:${p.key}`}
                      title={state?.error ?? p.display_name}
                      className={`rounded-md border px-2 py-0.5 font-mono text-[0.68rem] ${
                        !state
                          ? "border-edge text-dim/50"
                          : state.status === "ok"
                            ? "border-good/40 text-good"
                            : "border-bad/40 text-bad"
                      }`}
                    >
                      {p.display_name}
                      {state?.status === "ok" && state.confidence !== undefined
                        ? ` ${state.confidence}%`
                        : ""}
                      {state?.status === "ok" && state.duration_ms !== undefined
                        ? ` · ${(state.duration_ms / 1000).toFixed(1)}s`
                        : ""}
                      {state?.status === "error" ? " ✕" : ""}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
