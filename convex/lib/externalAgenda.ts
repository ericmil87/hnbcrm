/**
 * Agenda externa do atendente (v0.64) — helpers PUROS (sem ctx).
 *
 * O endpoint é da org (ex.: o site dela) e o JSON é dado de TERCEIRO: entra no
 * prompt como resultado de tool, então passa por uma whitelist de campos com
 * tetos de tamanho — nada além do que o atendente precisa para falar de data,
 * valor, vaga, local e inscrição chega ao modelo.
 */

export const DEFAULT_AGENDA_HEADER = "X-API-Key";
export const AGENDA_FETCH_TIMEOUT_MS = 8000;
export const MAX_AGENDA_EVENTS = 20;
export const MAX_AGENDA_LEADERS = 10;

export interface AgendaPricing {
  formatted: string | null;
  note: string | null;
}

export interface AgendaEvent {
  slug: string | null;
  title: string | null;
  category: string | null;
  categoryLabel: string | null;
  startsAtLocal: string | null;
  endsAtLocal: string | null;
  locationLabel: string | null;
  leaders: string[];
  pricing: AgendaPricing | null;
  spotsLeft: number | null;
  validationRequired: boolean | null;
  pageUrl: string | null;
  signupUrl: string | null;
  videoUrl: string | null;
  image: string | null;
}

function str(value: unknown, cap: number): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value).slice(0, cap);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, cap);
}

function leaderName(value: unknown): string | null {
  if (typeof value === "string") return str(value, 500);
  // Tolera `{ name }` — formato comum de API de site.
  if (value && typeof value === "object" && "name" in value) {
    return str((value as { name: unknown }).name, 500);
  }
  return null;
}

function normalizeEvent(raw: unknown): AgendaEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  const pricingRaw = e.pricing;
  let pricing: AgendaPricing | null = null;
  if (pricingRaw && typeof pricingRaw === "object" && !Array.isArray(pricingRaw)) {
    const p = pricingRaw as Record<string, unknown>;
    pricing = { formatted: str(p.formatted, 500), note: str(p.note, 300) };
  }
  const leaders = Array.isArray(e.leaders)
    ? e.leaders
        .map(leaderName)
        .filter((l): l is string => l !== null)
        .slice(0, MAX_AGENDA_LEADERS)
    : [];
  const spots = e.spotsLeft;
  return {
    slug: str(e.slug, 500),
    title: str(e.title, 200),
    category: str(e.category, 500),
    categoryLabel: str(e.categoryLabel, 500),
    startsAtLocal: str(e.startsAtLocal, 500),
    endsAtLocal: str(e.endsAtLocal, 500),
    locationLabel: str(e.locationLabel, 500),
    leaders,
    pricing,
    spotsLeft: typeof spots === "number" && Number.isFinite(spots) ? spots : null,
    validationRequired: typeof e.validationRequired === "boolean" ? e.validationRequired : null,
    pageUrl: str(e.pageUrl, 500),
    signupUrl: str(e.signupUrl, 500),
    videoUrl: str(e.videoUrl, 500),
    image: str(e.image, 500),
  };
}

/** Aceita `{events:[...]}` ou o array cru; devolve só os campos da whitelist. */
export function normalizeAgendaEvents(raw: unknown): AgendaEvent[] {
  let list: unknown = raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    list = (raw as { events?: unknown }).events;
  }
  if (!Array.isArray(list)) return [];
  const out: AgendaEvent[] = [];
  for (const item of list) {
    if (out.length >= MAX_AGENDA_EVENTS) break;
    const event = normalizeEvent(item);
    if (event) out.push(event);
  }
  return out;
}

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .trim();
}

/** Filtro por categoria, sem caixa nem acento, contra `category` ou `categoryLabel`. */
export function filterByCategory(events: AgendaEvent[], categoria?: string | null): AgendaEvent[] {
  const wanted = typeof categoria === "string" ? fold(categoria) : "";
  if (!wanted) return events;
  return events.filter((e) => {
    const candidates = [e.category, e.categoryLabel].filter((c): c is string => !!c).map(fold);
    return candidates.some((c) => c === wanted || c.includes(wanted));
  });
}

/** A IA só manda imagem que veio do campo `image` de um evento consultado (igualdade exata). */
export function isAllowedImageUrl(url: string, events: AgendaEvent[]): boolean {
  if (!url) return false;
  return events.some((e) => e.image !== null && e.image === url);
}

/** URL do endpoint aceita na configuração: só https. */
export function isValidAgendaUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Nome de header HTTP válido (token RFC 7230), sem espaço nem dois-pontos. */
export function isValidHeaderName(name: string): boolean {
  return /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name);
}

/** Teto do download do flyer. */
export const AGENDA_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const AGENDA_IMAGE_TIMEOUT_MS = 10_000;
