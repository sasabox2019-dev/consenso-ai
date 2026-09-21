import type { ConsensusResult } from "@consenso/shared";
import { useI18n } from "../i18n";
import { renderMarkdown } from "../markdown";

/** Collapsible per-agent, per-round details ("ver proceso"). */
export default function ProcessView({ result }: { result: ConsensusResult }) {
  const { t } = useI18n();
  return (
    <div className="mt-5 space-y-4 border-t border-edge pt-4">
      {result.participants.map((p) => (
        <details key={p.key} className="rounded-xl border border-edge bg-void/40">
          <summary className="cursor-pointer px-4 py-2.5 text-sm text-ink">
            {p.display_name}
            {p.unavailable && (
              <span className="ml-2 text-xs text-bad">· {t("unavailable_agents")}</span>
            )}
          </summary>
          <div className="space-y-3 px-4 pb-4">
            {p.rounds.map((slot, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: exactly two fixed rounds, index is the identity
              <div key={i}>
                <div className="mono-label mb-1">
                  {t("round")} {i + 1}
                  {slot.status === "ok" && ` · ${slot.data.confidence}%`}
                </div>
                {slot.status === "ok" ? (
                  <>
                    <div
                      className="md text-sm text-dim"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(slot.data.answer) }}
                    />
                    {slot.data.key_points.length > 0 && (
                      <>
                        <div className="mono-label mt-2 mb-1">{t("key_points")}</div>
                        <ul className="list-disc pl-5 text-xs text-dim">
                          {slot.data.key_points.map((k, j) => (
                            <li key={`${j}:${k}`}>{k}</li>
                          ))}
                        </ul>
                      </>
                    )}
                    {slot.data.concerns.length > 0 && (
                      <>
                        <div className="mono-label mt-2 mb-1">{t("concerns")}</div>
                        <ul className="list-disc pl-5 text-xs text-dim">
                          {slot.data.concerns.map((k, j) => (
                            <li key={`${j}:${k}`}>{k}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </>
                ) : (
                  <p className="rounded-lg border border-bad/30 bg-bad/5 p-2 text-xs text-bad">
                    {t("no_answer")}: {slot.error}
                  </p>
                )}
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
