/**
 * Agenda v2 (densa): preferências da tela lembradas neste aparelho (PURO; `Storage` entra por argumento para teste).
 * Visão, agrupamento, esquema de cores, densidade e filtro da Semana. localStorage pode falhar (modo privado, cota,
 * bloqueio): tudo em try/catch e valor inválido volta ao padrão.
 */
import { AGENDA_VIEWS, type AgendaView, type GroupParam } from "./agendaViewParams";
import { COLOR_SCHEMES, type ColorScheme } from "./agendaColors";

export const DENSITIES = ["compacta", "padrao", "confortavel"] as const;
export type Density = (typeof DENSITIES)[number];
/** Altura de uma hora (px) em cada densidade. */
export const DENSITY_HOUR_PX: Record<Density, number> = { compacta: 44, padrao: 56, confortavel: 72 };

export interface AgendaPrefs {
  view?: AgendaView;
  group?: GroupParam;
  color?: ColorScheme;
  density?: Density;
  /** Filtro da Semana: id do recurso, ou ausente = todos. */
  resource?: string;
}

export const PREFS_KEY = "hnbcrm:agenda:prefs:v1";
const keyFor = (organizationId: string) => `${PREFS_KEY}:${organizationId}`;

function pick<T extends string>(values: readonly T[], raw: unknown): T | undefined {
  return typeof raw === "string" && (values as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

/** Lê e valida; qualquer falha devolve `{}`. */
export function readPrefs(organizationId: string, storage: Pick<Storage, "getItem"> | null | undefined = safeStorage()): AgendaPrefs {
  try {
    const raw = storage?.getItem(keyFor(organizationId));
    if (!raw) return {};
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== "object") return {};
    return {
      view: pick(AGENDA_VIEWS, o.view),
      group: pick(["sala", "profissional"] as const, o.group),
      color: pick(COLOR_SCHEMES, o.color),
      density: pick(DENSITIES, o.density),
      resource: typeof o.resource === "string" && o.resource.length > 0 && o.resource.length < 64 ? o.resource : undefined,
    };
  } catch {
    return {};
  }
}

/** Mescla `patch` nas preferências salvas (chave `undefined` apaga). Falha de gravação é ignorada. */
export function writePrefs(
  organizationId: string,
  patch: { [K in keyof AgendaPrefs]: AgendaPrefs[K] | null },
  storage: Pick<Storage, "getItem" | "setItem"> | null | undefined = safeStorage()
): AgendaPrefs {
  const next: Record<string, unknown> = { ...readPrefs(organizationId, storage) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  try {
    storage?.setItem(keyFor(organizationId), JSON.stringify(next));
  } catch {
    /* sem armazenamento: a preferência vale só nesta sessão */
  }
  return next as AgendaPrefs;
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
