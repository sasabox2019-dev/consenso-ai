import type { ConsensusResult, IndividualResult, PublicAgent, StreamEvent } from "@consenso/shared";
/**
 * Home view: consensus (mission-control progress + result) and individual mode.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, askIndividual, fetchAgents, streamConsensus } from "../api";
import MetricsBar from "../components/MetricsBar";
import ProcessView from "../components/ProcessView";
import ProgressPanel, { type AgentRunState, type StageState } from "../components/ProgressPanel";
import { useI18n } from "../i18n";
import { renderMarkdown } from "../markdown";

type Mode = "consensus" | "individual";

interface RunState {
  stages: Record<string, StageState>;
  agents: Record<string, AgentRunState>;
  error: { code: string; message: string } | null;
}

const emptyRun = (): RunState => ({ stages: {}, agents: {}, error: null });

export default function HomeView() {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>("consensus");
  const [agentsPayload, setAgentsPayload] = useState<{
    participants: PublicAgent[];
    moderator: PublicAgent | null;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [individualAgent, setIndividualAgent] = useState<string>("");
  const [question, setQuestion] = useState("");
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<RunState>(emptyRun);
  const [result, setResult] = useState<ConsensusResult | null>(null);
  const [individualResult, setIndividualResult] = useState<IndividualResult | null>(null);
  const [individualBusy, setIndividualBusy] = useState(false);
  const [showProcess, setShowProcess] = useState(false);
  const [stopped, setStopped] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const individualAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetchAgents()
      .then((p) => {
        setAgentsPayload(p);
        setSelected(p.participants.slice(0, 3).map((a) => a.key));
        // Preselect only agents that can actually run (have a key configured).
        setIndividualAgent(p.participants.find((a) => a.has_api_key)?.key ?? "");
      })
      .catch((e) => setLoadError(e instanceof ApiError ? e.message : String(e)));
    // Cancel any in-flight request when leaving the view.
    return () => {
      abortRef.current?.abort();
      individualAbortRef.current?.abort();
    };
  }, []);

  const toggleAgent = (key: string) => {
    setSelected((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      if (prev.length >= 3) return [...prev.slice(1), key];
      return [...prev, key];
    });
  };

  const reset = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    individualAbortRef.current?.abort();
    individualAbortRef.current = null;
    setRun(emptyRun());
    setResult(null);
    setIndividualResult(null);
    setShowProcess(false);
    setStopped(false);
  };

  const handleEvent = useCallback((e: StreamEvent) => {
    setRun((prev) => {
      const next: RunState = {
        stages: { ...prev.stages },
        agents: { ...prev.agents },
        error: null,
      };
      const agentId = "round" in e && "agent_key" in e ? `${e.round}:${e.agent_key}` : null;
      switch (e.type) {
        case "status":
          next.stages[e.stage] = { status: "active" };
          break;
        case "round":
          next.stages[e.round === 1 ? "round1" : "round2"] = {
            status: e.status === "start" ? "active" : "done",
          };
          break;
        case "agent":
          if (agentId) {
            next.agents[agentId] = {
              status: e.status,
              confidence: e.confidence,
              duration_ms: e.duration_ms,
              error: e.error,
            };
          }
          break;
        case "moderation":
          next.stages.moderation = {
            status: e.status === "start" ? "active" : "done",
            fallback: e.fallback,
          };
          break;
        case "error":
          next.error = { code: e.code, message: e.message };
          break;
        case "final":
          break;
      }
      return next;
    });
    if (e.type === "final") setResult(e.result);
  }, []);

  const startConsensus = async () => {
    if (selected.length !== 3) {
      setRun({ ...emptyRun(), error: { code: "selection", message: t("select_three_error") } });
      return;
    }
    if (question.trim().length < 10) {
      setRun({ ...emptyRun(), error: { code: "question", message: t("question_too_short") } });
      return;
    }
    reset();
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamConsensus(
        { question: question.trim(), selected_agents: selected },
        handleEvent,
        controller.signal,
      );
    } catch (e) {
      // Only report "stopped" for user-initiated aborts of THIS run — not for
      // unmount cleanups (which abort via reset() with a cleared ref).
      if (abortRef.current === controller && e instanceof DOMException && e.name === "AbortError") {
        setStopped(true); // keep the partial progress visible with a neutral note
      } else if (!(e instanceof DOMException && e.name === "AbortError")) {
        setRun((prev) => ({
          ...prev,
          error: { code: "network", message: e instanceof ApiError ? e.message : String(e) },
        }));
      }
    } finally {
      setRunning(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const stopConsensus = () => abortRef.current?.abort();

  const startIndividual = async () => {
    if (question.trim().length < 10) {
      setRun({ ...emptyRun(), error: { code: "question", message: t("question_too_short") } });
      return;
    }
    if (!individualAgent) return;
    reset();
    setIndividualBusy(true);
    const controller = new AbortController();
    individualAbortRef.current = controller;
    try {
      const r = await askIndividual(
        { question: question.trim(), agent: individualAgent },
        controller.signal,
      );
      setIndividualResult(r);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setRun((prev) => ({
          ...prev,
          error: { code: "network", message: e instanceof ApiError ? e.message : String(e) },
        }));
      }
    } finally {
      setIndividualBusy(false);
      if (individualAbortRef.current === controller) individualAbortRef.current = null;
    }
  };

  const moderator = agentsPayload?.moderator ?? null;
  const sortedParticipants = useMemo(
    () =>
      [...(agentsPayload?.participants ?? [])].sort((a, b) =>
        a.display_name.localeCompare(b.display_name),
      ),
    [agentsPayload],
  );

  return (
    <div className="space-y-5">
      {/* mode tabs — locked while a consensus run is streaming */}
      <div className="flex gap-2">
        {(["consensus", "individual"] as Mode[]).map((m) => (
          <button
            type="button"
            key={m}
            disabled={running || individualBusy}
            onClick={() => {
              setMode(m);
              reset();
            }}
            className={`rounded-xl px-4 py-2 text-sm font-medium transition disabled:opacity-40 ${
              mode === m
                ? "bg-panel2 text-cyan border border-cyan/40"
                : "text-dim border border-transparent hover:text-ink"
            }`}
          >
            {t(m === "consensus" ? "nav_consensus" : "nav_individual")}
          </button>
        ))}
      </div>

      {/* agent selection */}
      {mode === "consensus" && (
        <section className="panel p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">{t("agents_title")}</h2>
            <span className="mono-label">{selected.length}/3</span>
          </div>
          {loadError && <p className="text-sm text-bad">{loadError}</p>}
          <div className="flex flex-wrap gap-2">
            {sortedParticipants.map((a) => {
              const isSel = selected.includes(a.key);
              return (
                <button
                  type="button"
                  key={a.key}
                  onClick={() => toggleAgent(a.key)}
                  aria-pressed={isSel}
                  className={`flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm transition ${
                    isSel
                      ? "border-cyan/60 bg-cyan/10 text-ink glow-cyan"
                      : "border-edge text-dim hover:border-dim"
                  }`}
                >
                  <span className={`h-2 w-2 rounded-full ${isSel ? "bg-cyan" : "bg-edge"}`} />
                  {a.display_name}
                  {!a.has_api_key && <span className="mono-label">({t("key_missing")})</span>}
                </button>
              );
            })}
          </div>
          {moderator && (
            <div className="mt-3 flex items-center gap-2 text-sm text-dim">
              <span className="h-2 w-2 rounded-full bg-violet" />
              <span className="text-violet">{moderator.display_name}</span>
              <span>· {t("moderator_label")}</span>
            </div>
          )}
          {sortedParticipants.length < 3 && !loadError && (
            <p className="mt-2 text-sm text-warn">{t("agents_need")}</p>
          )}
          {!moderator && !loadError && (
            <p className="mt-2 text-sm text-warn">{t("no_moderator")}</p>
          )}
        </section>
      )}

      {/* individual agent select */}
      {mode === "individual" && (
        <section className="panel p-4">
          <h2 className="mb-3 text-sm font-semibold text-ink">{t("individual_pick")}</h2>
          <div className="flex flex-wrap gap-2">
            {[...(agentsPayload?.participants ?? []), ...(moderator ? [moderator] : [])]
              .filter((a) => a.has_api_key)
              .map((a) => (
                <button
                  type="button"
                  key={a.key}
                  onClick={() => setIndividualAgent(a.key)}
                  aria-pressed={individualAgent === a.key}
                  className={`rounded-xl border px-3.5 py-2 text-sm transition ${
                    individualAgent === a.key
                      ? "border-violet/60 bg-violet/10 text-ink"
                      : "border-edge text-dim hover:border-dim"
                  }`}
                >
                  {a.display_name}
                </button>
              ))}
          </div>
        </section>
      )}

      {/* question */}
      <section className="panel p-4">
        <label htmlFor="question" className="mono-label mb-2 block">
          {t("question_label")}
        </label>
        <textarea
          id="question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={t("question_placeholder")}
          rows={3}
          maxLength={1000}
          className="w-full resize-y rounded-xl border border-edge bg-void/60 p-3 text-sm text-ink outline-none transition placeholder:text-dim/60 focus:border-cyan/60"
        />
        <div className="mt-3 flex items-center justify-between">
          <span className="mono-label">{question.length}/1000</span>
          {mode === "consensus" ? (
            running ? (
              <button
                type="button"
                onClick={stopConsensus}
                className="rounded-xl border border-bad/50 px-5 py-2 text-sm text-bad transition hover:bg-bad/10"
              >
                {t("stop")}
              </button>
            ) : (
              <button
                type="button"
                onClick={startConsensus}
                disabled={sortedParticipants.length < 3}
                className="rounded-xl bg-gradient-to-r from-cyan/80 to-violet/80 px-5 py-2 text-sm font-semibold text-void transition hover:brightness-110 disabled:opacity-40"
              >
                {t("start_consensus")}
              </button>
            )
          ) : (
            <button
              type="button"
              onClick={startIndividual}
              disabled={individualBusy || !individualAgent}
              className="rounded-xl bg-gradient-to-r from-violet/80 to-cyan/80 px-5 py-2 text-sm font-semibold text-void transition hover:brightness-110 disabled:opacity-40"
            >
              {individualBusy ? t("running") : t("individual_start")}
            </button>
          )}
        </div>
      </section>

      {/* live progress — visible while running and after a manual stop */}
      {(running || stopped) && mode === "consensus" && (
        <>
          <ProgressPanel
            stages={run.stages}
            agents={run.agents}
            participants={sortedParticipants.filter((a) => selected.includes(a.key))}
            done={Boolean(result)}
          />
          {stopped && !result && (
            <p className="mono-label text-center text-dim">{t("stopped_msg")}</p>
          )}
        </>
      )}

      {/* error */}
      {run.error && (
        <section className="panel border-bad/40 p-4" role="alert">
          <p className="text-sm text-bad">
            <strong>{t("error_title")}:</strong> {run.error.message}
          </p>
        </section>
      )}

      {/* consensus result */}
      {result && mode === "consensus" && (
        <section className="panel enter p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink">{t("result_title")}</h2>
            <div className="flex items-center gap-3">
              {result.from_cache && <span className="mono-label">{t("from_cache")}</span>}
              <button
                type="button"
                onClick={() => setShowProcess((s) => !s)}
                className="mono-label transition hover:text-cyan"
              >
                {showProcess ? t("process_hide") : t("process_title")}
              </button>
            </div>
          </div>
          <MetricsBar metrics={result.metrics} />
          {(result.degraded || result.unavailable_agents.length > 0) && (
            <p className="mt-3 rounded-lg border border-warn/40 bg-warn/10 p-2.5 text-xs text-warn">
              {result.moderator_fallback ? t("fallback_notice") : t("degraded_notice")}
              {result.unavailable_agents.length > 0 && (
                <>
                  {" "}
                  · {t("unavailable_agents")}: {result.unavailable_agents.join(", ")}
                </>
              )}
            </p>
          )}
          <div
            className="md mt-4 text-sm text-ink"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(result.consensus) }}
          />
          {showProcess && <ProcessView result={result} />}
        </section>
      )}

      {/* individual result */}
      {individualResult && mode === "individual" && (
        <section className="panel enter p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink">{individualResult.display_name}</h2>
            <span className="mono-label">
              {t("metrics_confidence")}: {individualResult.confidence}% ·{" "}
              {individualResult.processing_time_s}s
            </span>
          </div>
          <div
            className="md text-sm text-ink"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(individualResult.answer) }}
          />
          {individualResult.key_points.length > 0 && (
            <div className="mt-4">
              <h3 className="mono-label mb-1">{t("key_points")}</h3>
              <ul className="list-disc pl-5 text-sm text-dim">
                {individualResult.key_points.map((p, i) => (
                  <li key={`${i}:${p}`}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {individualResult.concerns.length > 0 && (
            <div className="mt-3">
              <h3 className="mono-label mb-1">{t("concerns")}</h3>
              <ul className="list-disc pl-5 text-sm text-dim">
                {individualResult.concerns.map((p, i) => (
                  <li key={`${i}:${p}`}>{p}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
