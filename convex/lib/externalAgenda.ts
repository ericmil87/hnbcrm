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

/**
 * Filtro por categoria, sem caixa nem acento, contra `category`, `categoryLabel`
 * E `title`. Nenhuma taxonomia é fixa aqui: cada site nomeia as categorias do
 * seu jeito (um chama "medicinas", outro "ayahuasca"), então o modelo pode
 * filtrar com qualquer palavra que apareça no nome ou na categoria do evento —
 * e quem decide o que existe é a resposta da agenda (`availableCategories`).
 */
export function filterByCategory(events: AgendaEvent[], categoria?: string | null): AgendaEvent[] {
  const wanted = typeof categoria === "string" ? fold(categoria) : "";
  if (!wanted) return events;
  return events.filter((e) => {
    const candidates = [e.category, e.categoryLabel, e.title]
      .filter((c): c is string => !!c)
      .map(fold);
    return candidates.some((c) => c === wanted || c.includes(wanted));
  });
}

/**
 * Categorias que a agenda de fato usa (rótulo e id), na ordem em que aparecem.
 * Vai no resultado da tool para o modelo aprender a taxonomia DO SITE em vez de
 * chutar nomes — é o que torna a tool genérica entre clientes.
 */
export function availableCategories(events: AgendaEvent[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of events) {
    const label = e.categoryLabel ?? e.category;
    if (!label) continue;
    const entry = e.category && e.category !== label ? `${label} (${e.category})` : label;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
    if (out.length >= 30) break;
  }
  return out;
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

// ─────────────────────────────────────────────────────────────────────────────
// Agenda como TEXTO de prompt (publicação programada por IA, 07/10/2026)
// ─────────────────────────────────────────────────────────────────────────────

/** Teto do bloco de agenda no prompt da publicação (chars). */
export const AGENDA_PROMPT_MAX_CHARS = 4000;

export const AGENDA_PROMPT_HEADER =
  "AGENDA ATUAL (consultada agora na agenda externa da empresa — fonte de verdade para nome, data, horário, local, contribuição/valor e inscrição dos eventos; eventos já encerrados foram removidos):";
export const AGENDA_PROMPT_EMPTY =
  "AGENDA ATUAL: nenhum evento futuro aberto no momento — não cite datas, horários, locais ou valores de eventos.";
export const AGENDA_PROMPT_UNAVAILABLE =
  "AGENDA ATUAL: indisponível neste momento (não foi possível consultar) — não cite datas, horários, locais ou valores de eventos; se a instrução pedir um chamado da agenda, escolha outro formato previsto na instrução.";

const ISO_LIKE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** "AAAA-MM-DDTHH:mm" de um instante no fuso dado (fuso inválido = UTC). */
function localStamp(at: number, timezone: string): string {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return new Date(at).toISOString().slice(0, 16);
  }
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(at))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/**
 * O evento já acabou? `endsAtLocal ?? startsAtLocal`, como veio da API:
 *  - com fuso explícito (`Z`/`-03:00`) → instante absoluto contra `now`;
 *  - sem fuso → hora LOCAL da org, comparada com o "agora" no `timezone`
 *    (o nome do campo diz que é local; converter por UTC erraria 3 h no Brasil);
 *  - só data → vale até o fim daquele dia;
 *  - qualquer outro formato → não dá para saber, o evento FICA (esconder um
 *    evento aberto é tão ruim quanto citar um encerrado, e o prompt manda não
 *    inventar).
 */
export function isAgendaEventPast(event: AgendaEvent, now: number, timezone: string): boolean {
  const raw = (event.endsAtLocal ?? event.startsAtLocal)?.trim();
  if (!raw) return false;
  const m = raw.match(ISO_LIKE);
  if (!m) return false;
  const [, y, mo, d, hh, mm, , zone] = m;
  if (zone && hh !== undefined) {
    const at = Date.parse(raw.replace(" ", "T"));
    return Number.isFinite(at) ? at < now : false;
  }
  const nowLocal = localStamp(now, timezone);
  if (hh === undefined) return `${y}-${mo}-${d}` < nowLocal.slice(0, 10);
  return `${y}-${mo}-${d}T${hh}:${mm}` < nowLocal;
}

/** Uma linha por evento: dado de terceiro — sem quebra de linha, com teto. */
function oneLine(value: string | null | undefined, cap = 300): string | null {
  if (!value) return null;
  const flat = value.replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, cap) : null;
}

function agendaEventLine(e: AgendaEvent): string {
  const parts: string[] = [];
  parts.push(oneLine(e.title, 200) ?? "(evento sem título)");
  const category = oneLine(e.categoryLabel ?? e.category, 120);
  if (category) parts.push(`categoria: ${category}`);
  const starts = oneLine(e.startsAtLocal, 60);
  const ends = oneLine(e.endsAtLocal, 60);
  if (starts || ends) parts.push(`quando: ${[starts, ends].filter(Boolean).join(" – ")}`);
  const location = oneLine(e.locationLabel, 200);
  if (location) parts.push(`local: ${location}`);
  const leaders = e.leaders.map((l) => oneLine(l, 100)).filter(Boolean);
  if (leaders.length > 0) parts.push(`condução: ${leaders.join(", ")}`);
  const price = oneLine(e.pricing?.formatted, 200);
  const priceNote = oneLine(e.pricing?.note, 200);
  if (price || priceNote) {
    parts.push(`contribuição: ${[price, priceNote ? `(${priceNote})` : null].filter(Boolean).join(" ")}`);
  }
  if (e.spotsLeft !== null) parts.push(`vagas restantes: ${e.spotsLeft}`);
  if (e.validationRequired === true) parts.push("participação passa por conversa prévia");
  const page = oneLine(e.pageUrl, 500);
  if (page) parts.push(`página: ${page}`);
  const signup = oneLine(e.signupUrl, 500);
  if (signup && signup !== page) parts.push(`inscrição: ${signup}`);
  return `- ${parts.join(" | ")}`;
}

/**
 * Agenda → bloco de TEXTO para o system prompt da publicação programada (que
 * não tem tools). Ordem da API preservada; eventos encerrados saem; teto de
 * `maxEvents` (20) e ~`AGENDA_PROMPT_MAX_CHARS`, com o que sobrou contado.
 */
export function formatAgendaForPrompt(
  events: AgendaEvent[],
  opts: { now: number; timezone: string; maxEvents?: number }
): string {
  const maxEvents = Math.max(1, Math.min(opts.maxEvents ?? MAX_AGENDA_EVENTS, MAX_AGENDA_EVENTS));
  const open = events.filter((e) => !isAgendaEventPast(e, opts.now, opts.timezone));
  if (open.length === 0) return AGENDA_PROMPT_EMPTY;

  const lines: string[] = [AGENDA_PROMPT_HEADER];
  let size = AGENDA_PROMPT_HEADER.length;
  let shown = 0;
  for (const e of open) {
    if (shown >= maxEvents) break;
    const line = agendaEventLine(e);
    // Reserva ~60 chars para a linha de "omitidos".
    if (shown > 0 && size + 1 + line.length > AGENDA_PROMPT_MAX_CHARS - 60) break;
    const kept = line.slice(0, AGENDA_PROMPT_MAX_CHARS - 60 - size - 1);
    lines.push(kept);
    size += 1 + kept.length;
    shown++;
  }
  const omitted = open.length - shown;
  if (omitted > 0) lines.push(`(+${omitted} evento(s) não listado(s) por falta de espaço)`);
  return lines.join("\n");
}
