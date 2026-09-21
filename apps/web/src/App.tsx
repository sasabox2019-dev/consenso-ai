import { useEffect, useState } from "react";
import { useI18n } from "./i18n";
import AdminView from "./views/AdminView";
import HomeView from "./views/HomeView";

function useHashRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash.replace(/^#\/?/, ""));
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash.replace(/^#\/?/, ""));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export default function App() {
  const route = useHashRoute();
  const { t, lang, setLang } = useI18n();
  const isAdmin = route.startsWith("admin");

  return (
    <div className="mx-auto flex min-h-full max-w-5xl flex-col px-4 pb-10">
      <header className="flex items-center justify-between py-5">
        <a href="#/" className="group flex items-center gap-3">
          <span className="relative flex h-9 w-9 items-center justify-center rounded-full border border-cyan glow-cyan">
            <span className="h-2.5 w-2.5 rounded-full bg-violet" />
          </span>
          <span>
            <span className="block text-lg font-bold tracking-tight text-white">
              Consenso<span className="text-cyan">·AI</span>
            </span>
            <span className="mono-label">{t("app_tagline")}</span>
          </span>
        </a>
        <nav className="flex items-center gap-2 text-sm">
          <a
            href="#/"
            className={`rounded-lg px-3 py-1.5 transition ${!isAdmin ? "bg-panel2 text-cyan" : "text-dim hover:text-ink"}`}
          >
            {t("nav_consensus")}
          </a>
          <a
            href="#/admin"
            className={`rounded-lg px-3 py-1.5 transition ${isAdmin ? "bg-panel2 text-cyan" : "text-dim hover:text-ink"}`}
          >
            {t("nav_admin")}
          </a>
          <button
            type="button"
            onClick={() => setLang(lang === "es" ? "en" : "es")}
            className="rounded-lg border border-edge px-2.5 py-1.5 font-mono text-xs text-dim transition hover:border-cyan hover:text-cyan"
            aria-label="switch language"
          >
            {t("lang_toggle")}
          </button>
        </nav>
      </header>

      <main className="flex-1">{isAdmin ? <AdminView /> : <HomeView />}</main>

      <footer className="mono-label pt-8 text-center">{t("footer_note")}</footer>
    </div>
  );
}
