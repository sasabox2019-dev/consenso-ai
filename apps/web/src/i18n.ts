/**
 * Bilingual UI strings (ES default). Language persisted in localStorage,
 * initialized from navigator.language.
 */
import {
  type ReactNode,
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type Lang = "es" | "en";

const dict = {
  es: {
    app_tagline: "Varias IAs debaten · una moderadora sintetiza",
    nav_consensus: "Consenso",
    nav_individual: "Individual",
    nav_admin: "Admin",
    lang_toggle: "EN",
    agents_title: "Selecciona tus expertas (2 a 5)",
    rounds_label: "Rondas de revisión",
    structured_outputs: "Salidas JSON estructuradas",
    max_completion: "Usar max_completion_tokens (modelos de razonamiento OpenAI)",
    agents_need: "Se necesitan 3 participantes activos para el consenso.",
    moderator_label: "Moderadora fija",
    question_placeholder: "Escribe tu pregunta (mín. 10 caracteres, máx. 1000)…",
    start_consensus: "Iniciar consenso",
    running: "Procesando…",
    stop: "Detener",
    stopped_msg: "Proceso detenido. Puedes iniciar un nuevo consenso cuando quieras.",
    no_moderator: "No hay moderadora configurada — un administrador debe añadirla.",
    stage_round1: "Ronda 1 · respuestas independientes",
    stage_round2: "Ronda 2 · revisión cruzada",
    stage_moderation: "Síntesis de la moderadora",
    result_title: "Respuesta consensuada",
    process_title: "Ver proceso",
    process_hide: "Ocultar proceso",
    metrics_confidence: "Confianza",
    metrics_agreement: "Acuerdo",
    metrics_time: "Tiempo",
    metrics_agents: "Agentes",
    degraded_notice:
      "Modo degradado: algunas respuestas provienen de participantes o síntesis local.",
    fallback_notice: "La moderadora falló; se muestra una síntesis local priorizada (no moderada).",
    unavailable_agents: "Agentes no disponibles",
    from_cache: "desde caché",
    question_label: "Pregunta",
    error_title: "Error",
    individual_pick: "Elige una IA",
    individual_start: "Consultar",
    key_points: "Puntos clave",
    concerns: "Limitaciones",
    round: "Ronda",
    no_answer: "Sin respuesta",
    footer_note: "Las respuestas pueden contener errores. Verifica información crítica.",
    admin_bootstrap_title: "Primer arranque",
    admin_bootstrap_desc:
      "Crea la cuenta de administrador. Usa una contraseña larga (mín. 12 caracteres).",
    username: "Usuario",
    password: "Contraseña",
    password_new: "Nueva contraseña",
    password_current: "Contraseña actual",
    generate: "Generar",
    bootstrap: "Crear administrador",
    login: "Entrar",
    logout: "Salir",
    login_title: "Acceso administrador",
    agents_crud_title: "Agentes IA",
    add_agent: "Añadir agente",
    edit: "Editar",
    delete: "Eliminar",
    save: "Guardar",
    cancel: "Cancelar",
    role: "Rol",
    participant: "Participante",
    moderator: "Moderadora",
    model: "Modelo",
    url: "URL de la API",
    api_key: "API key",
    api_key_keep: "dejar sin cambios",
    timeout: "Timeout (s)",
    active: "Activo",
    test_connection: "Probar conexión",
    test_ok: "Conexión exitosa",
    test_fail: "Conexión fallida",
    audit_title: "Registro de auditoría",
    change_password: "Cambiar contraseña",
    welcome_admin: "Panel de administración",
    confirm_delete: "¿Eliminar este agente?",
    key_configured: "configurada",
    key_missing: "sin configurar",
    test_sample: "Muestra",
    time_ms: "ms",
    select_range_error: "Debes seleccionar entre 2 y 5 expertas.",
    question_too_short: "La pregunta es demasiado corta (mínimo 10 caracteres).",
  },
  en: {
    app_tagline: "Multiple AIs debate · one moderator synthesizes",
    nav_consensus: "Consensus",
    nav_individual: "Individual",
    nav_admin: "Admin",
    lang_toggle: "ES",
    agents_title: "Select your experts (2 to 5)",
    rounds_label: "Review rounds",
    structured_outputs: "Structured JSON outputs",
    max_completion: "Use max_completion_tokens (OpenAI reasoning models)",
    agents_need: "3 active participants are required for consensus.",
    moderator_label: "Fixed moderator",
    question_placeholder: "Type your question (min. 10 chars, max. 1000)…",
    start_consensus: "Start consensus",
    running: "Processing…",
    stop: "Stop",
    stopped_msg: "Stopped. You can start a new consensus whenever you like.",
    no_moderator: "No moderator configured — an administrator must add one.",
    stage_round1: "Round 1 · independent answers",
    stage_round2: "Round 2 · cross review",
    stage_moderation: "Moderator synthesis",
    result_title: "Consensus answer",
    process_title: "View process",
    process_hide: "Hide process",
    metrics_confidence: "Confidence",
    metrics_agreement: "Agreement",
    metrics_time: "Time",
    metrics_agents: "Agents",
    degraded_notice:
      "Degraded mode: some content comes from remaining participants or local synthesis.",
    fallback_notice: "Moderator failed; showing a prioritized local synthesis (not moderated).",
    unavailable_agents: "Unavailable agents",
    from_cache: "from cache",
    question_label: "Question",
    error_title: "Error",
    individual_pick: "Choose an AI",
    individual_start: "Ask",
    key_points: "Key points",
    concerns: "Limitations",
    round: "Round",
    no_answer: "No answer",
    footer_note: "Answers may contain errors. Verify critical information.",
    admin_bootstrap_title: "First run",
    admin_bootstrap_desc:
      "Create the administrator account. Use a long password (min. 12 characters).",
    username: "Username",
    password: "Password",
    password_new: "New password",
    password_current: "Current password",
    generate: "Generate",
    bootstrap: "Create administrator",
    login: "Sign in",
    logout: "Sign out",
    login_title: "Administrator access",
    agents_crud_title: "AI agents",
    add_agent: "Add agent",
    edit: "Edit",
    delete: "Delete",
    save: "Save",
    cancel: "Cancel",
    role: "Role",
    participant: "Participant",
    moderator: "Moderator",
    model: "Model",
    url: "API URL",
    api_key: "API key",
    api_key_keep: "leave unchanged",
    timeout: "Timeout (s)",
    active: "Active",
    test_connection: "Test connection",
    test_ok: "Connection successful",
    test_fail: "Connection failed",
    audit_title: "Audit log",
    change_password: "Change password",
    welcome_admin: "Administration panel",
    confirm_delete: "Delete this agent?",
    key_configured: "configured",
    key_missing: "not configured",
    test_sample: "Sample",
    time_ms: "ms",
    select_range_error: "You must select between 2 and 5 experts.",
    question_too_short: "The question is too short (minimum 10 characters).",
  },
} as const;

export type DictKey = keyof (typeof dict)["es"];

const LangCtx = createContext<{
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (k: DictKey) => string;
}>({
  lang: "es",
  setLang: () => {},
  t: (k) => dict.es[k],
});

const STORAGE_KEY = "consenso-lang";

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "es" || stored === "en") return stored;
    return navigator.language.toLowerCase().startsWith("en") ? "en" : "es";
  });

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // Stable context value: consumers don't re-render on unrelated parent renders.
  const value = useMemo(
    () => ({
      lang,
      setLang: (l: Lang) => {
        setLangState(l);
        localStorage.setItem(STORAGE_KEY, l);
      },
      t: (k: DictKey) => dict[lang][k] ?? dict.es[k],
    }),
    [lang],
  );
  return createElement(LangCtx.Provider, { value }, children);
}

export function useI18n() {
  return useContext(LangCtx);
}
