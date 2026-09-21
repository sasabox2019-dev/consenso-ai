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
}

const STAGES = [
  { id: "round1", key: "stage_round1" },
  { id: "round2", key: "stage_round2" },
  { id: "moderation", key: "stage_moderation" },
] as const;

export default function ProgressPanel({ stages, agents, participants, done }: Props) {
  const { t } = useI18n();
  return (
    <section className="panel p-4" aria-live="polite">
      <div className="mb-3 flex items-center gap-2">
        {!done && <span className="pulse-dot" />}
        <span className="mono-label">{done ? t("result_title") : t("running")}</span>
      </div>
      <div className="space-y-3">
        {STAGES.map((s, idx) => {
          const state = stages[s.id];
          const isActive = state?.status === "active";
          const isDone = state?.status === "done";
          const roundAgents =
            s.id === "moderation"
              ? []
              : (idx === 0 ? [1] : [2]).flatMap((r) =>
                  participants.map((p) => ({ r, p, state: agents[`${r}:${p.key}`] })),
                );
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
                  {t(s.key)}
                  {s.id === "moderation" && state?.fallback ? " · ⚠" : ""}
                </span>
                {isActive && !isDone && <span className="stage-line ml-2 w-16 rounded-full" />}
              </div>
              {roundAgents.length > 0 && (
                <div className="ml-4 mt-1.5 flex flex-wrap gap-1.5">
                  {roundAgents.map(({ r, p, state }) => (
                    <span
                      key={`${r}:${p.key}`}
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
