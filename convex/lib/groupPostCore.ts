/**
 * Núcleo PURO das publicações programadas em grupos (F3) — escolha do item da
 * biblioteca, renderização do texto, validação do conteúdo e aritmética de
 * horário. Sem Convex, sem `Date.now()`: tudo entra por argumento.
 *
 * A agenda propriamente dita (fuso, DST, jitter, `slotKey`) mora em
 * `lib/groupPostSchedule.ts` — este arquivo cuida do CONTEÚDO.
 *
 * Duas decisões que explicam o resto:
 *
 *  1. **A escolha do item é DETERMINÍSTICA.** Sequencial anda num cursor
 *     circular persistido; aleatório usa o PRNG por seed de `campaignRender`
 *     com a seed do slot. Rodar o mesmo slot duas vezes (retry, tick zumbi)
 *     escolhe o MESMO item — a idempotência por `lastSlotKey` fecha o buraco,
 *     mas ela não pode ser a única linha de defesa.
 *  2. **`noRepeatWindow` é uma lista de índices recentes, não um histórico.**
 *     Guardamos só os últimos N escolhidos (`recentIndexes`) porque é tudo o
 *     que a regra "não repita os últimos N" precisa, e cabe no doc.
 */

import { renderText, seededRandom, type RecipientVars } from "./campaignRender";

// ── Tetos ──

/** Grupos por publicação. Um disparo bate em todos eles no mesmo slot. */
export const MAX_POST_TARGETS = 20;
/** Itens na biblioteca de uma publicação. */
export const MAX_LIBRARY_ITEMS = 50;
/** Caracteres de um item (WhatsApp corta bem antes disso). */
export const MAX_POST_TEXT_CHARS = 4000;
/** Entradas guardadas na linha do tempo da publicação. */
export const POST_TIMELINE_CAP = 100;
/**
 * Publicações automáticas por DIA e por CANAL (§6 do plano). Conta SLOTS
 * disparados, não mensagens: um slot que posta em 5 grupos consome 1. Contar
 * mensagens faria uma publicação com 11 grupos nunca caber no teto, e o
 * espaçamento entre as mensagens já é responsabilidade do pacing do canal.
 */
export const MAX_POSTS_PER_CHANNEL_PER_DAY = 10;
/** Publicações anteriores mandadas ao LLM para ele não repetir o assunto. */
export const AI_RECENT_POSTS_CONTEXT = 5;

// ── Tipos ──

export type LibraryOrder = "sequential" | "random";

export interface LibraryItem {
  text: string;
  attachmentFileIds?: unknown[];
  contentType?: "text" | "image" | "file" | "audio";
}

export interface PickLibraryItemResult {
  index: number;
  nextCursor: number;
  nextRecentIndexes: number[];
}

/**
 * Escolhe o próximo item da biblioteca.
 *
 * - `sequential`: cursor circular (o cursor devolvido já aponta para o próximo).
 * - `random`: sorteio determinístico por `seed` entre os índices que NÃO estão
 *   na janela de não-repetição. Se a janela engoliu todo mundo (config
 *   inconsistente, ou biblioteca que encolheu), ela é ignorada neste sorteio —
 *   melhor repetir do que não publicar.
 */
export function pickLibraryItem(
  items: readonly unknown[],
  order: LibraryOrder,
  cursor: number | undefined,
  recentIndexes: readonly number[] | undefined,
  noRepeatWindow: number | undefined,
  seed: string
): PickLibraryItemResult | null {
  const total = items.length;
  if (total === 0) return null;

  const window = Math.max(0, Math.min(total - 1, Math.floor(noRepeatWindow ?? 0)));
  const recent = (recentIndexes ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < total);

  let index: number;
  let nextCursor: number;

  if (order === "sequential") {
    const start = Number.isInteger(cursor) && (cursor as number) >= 0 ? (cursor as number) % total : 0;
    index = start;
    nextCursor = (start + 1) % total;
  } else {
    const blocked = new Set(recent.slice(-window));
    const candidates: number[] = [];
    for (let i = 0; i < total; i++) if (!blocked.has(i)) candidates.push(i);
    const pool = candidates.length > 0 ? candidates : Array.from({ length: total }, (_, i) => i);
    const rng = seededRandom(seed);
    index = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
    nextCursor = Number.isInteger(cursor) && (cursor as number) >= 0 ? (cursor as number) % total : 0;
  }

  const nextRecentIndexes = window > 0 ? [...recent, index].slice(-window) : [];
  return { index, nextCursor, nextRecentIndexes };
}

// ── Variáveis do texto ──

const WEEKDAY_PT: Record<number, string> = {
  1: "segunda-feira",
  2: "terça-feira",
  3: "quarta-feira",
  4: "quinta-feira",
  5: "sexta-feira",
  6: "sábado",
  7: "domingo",
};

const MONTH_PT = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

function safeTimezone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "America/Sao_Paulo";
  }
}

/**
 * Variáveis disponíveis no texto de um item: `{{grupo}}`, `{{data}}`,
 * `{{dia_semana}}`, `{{hora}}`, `{{mes}}`, `{{ano}}`. As chaves passam pela
 * normalização de `campaignRender` (sem acento, minúsculas, `_` no lugar de
 * espaço), então `{{Dia Semana}}` também casa.
 */
export function buildPostVars(args: {
  groupName: string;
  at: number;
  timezone: string;
}): Record<string, string> {
  const tz = safeTimezone(args.timezone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(args.at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  const jsWeekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const weekday = jsWeekday === 0 ? 7 : jsWeekday;
  return {
    grupo: args.groupName,
    data: `${get("day")}/${get("month")}/${get("year")}`,
    dia_semana: WEEKDAY_PT[weekday] ?? "",
    hora: `${get("hour")}:${get("minute")}`,
    mes: MONTH_PT[m - 1] ?? "",
    ano: get("year"),
  };
}

/** Renderiza o texto final de um grupo: `{{vars}}` primeiro, depois spintax. */
export function renderPostText(
  text: string,
  vars: Record<string, string>,
  seed: string
): string {
  const recipient: RecipientVars = { vars };
  return renderText(text, recipient, seed);
}

// ── Validação do conteúdo ──

export type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Valida o bloco `content` vindo de fora (create/update). Espelha o que o
 * worker precisa encontrar mais tarde: biblioteca sem item nenhum e IA sem
 * prompt são os dois jeitos de criar uma publicação que só falha na hora H.
 */
export function validateGroupPostContent(content: unknown): ValidationResult {
  if (typeof content !== "object" || content === null) {
    return { ok: false, error: "conteúdo inválido" };
  }
  const c = content as Record<string, any>;

  if (c.kind === "library") {
    const lib = c.library;
    if (!lib || !Array.isArray(lib.items) || lib.items.length === 0) {
      return { ok: false, error: "A biblioteca precisa de pelo menos uma mensagem" };
    }
    if (lib.items.length > MAX_LIBRARY_ITEMS) {
      return { ok: false, error: `A biblioteca aceita no máximo ${MAX_LIBRARY_ITEMS} mensagens` };
    }
    for (const [i, item] of lib.items.entries()) {
      const text = typeof item?.text === "string" ? item.text.trim() : "";
      const hasAttachment = Array.isArray(item?.attachmentFileIds) && item.attachmentFileIds.length > 0;
      if (!text && !hasAttachment) {
        return { ok: false, error: `A mensagem ${i + 1} está vazia` };
      }
      if (typeof item?.text === "string" && item.text.length > MAX_POST_TEXT_CHARS) {
        return { ok: false, error: `A mensagem ${i + 1} passa de ${MAX_POST_TEXT_CHARS} caracteres` };
      }
      // Um anexo por mensagem: é o que o bridge envia por chamada.
      if (Array.isArray(item?.attachmentFileIds) && item.attachmentFileIds.length > 1) {
        return { ok: false, error: `A mensagem ${i + 1} só pode ter um anexo` };
      }
    }
    if (lib.order !== "sequential" && lib.order !== "random") {
      return { ok: false, error: "A ordem da biblioteca deve ser sequencial ou aleatória" };
    }
    if (lib.noRepeatWindow !== undefined) {
      if (!Number.isInteger(lib.noRepeatWindow) || lib.noRepeatWindow < 0 || lib.noRepeatWindow >= lib.items.length) {
        return {
          ok: false,
          error: `A janela sem repetição deve ser um inteiro entre 0 e ${lib.items.length - 1}`,
        };
      }
    }
    return { ok: true };
  }

  if (c.kind === "ai") {
    const ai = c.ai;
    if (!ai || typeof ai.prompt !== "string" || ai.prompt.trim().length === 0) {
      return { ok: false, error: "Descreva o que a IA deve publicar" };
    }
    if (ai.prompt.length > MAX_POST_TEXT_CHARS) {
      return { ok: false, error: `A instrução passa de ${MAX_POST_TEXT_CHARS} caracteres` };
    }
    if (!Number.isInteger(ai.generateMinutesBefore) || ai.generateMinutesBefore < 5 || ai.generateMinutesBefore > 1440) {
      return { ok: false, error: "Gere entre 5 e 1440 minutos antes do horário" };
    }
    if (ai.maxChars !== undefined) {
      if (!Number.isInteger(ai.maxChars) || ai.maxChars < 50 || ai.maxChars > MAX_POST_TEXT_CHARS) {
        return { ok: false, error: `O tamanho máximo deve ficar entre 50 e ${MAX_POST_TEXT_CHARS} caracteres` };
      }
    }
    if (ai.onMissedApproval !== "skip" && ai.onMissedApproval !== "send") {
      return { ok: false, error: "Escolha o que fazer quando a aprovação não vier a tempo" };
    }
    if (ai.persona === "custom" && (typeof ai.customPersona !== "string" || ai.customPersona.trim().length === 0)) {
      return { ok: false, error: "Escreva a persona personalizada ou use a do atendente" };
    }
    return { ok: true };
  }

  return { ok: false, error: "Escolha entre biblioteca de mensagens ou geração por IA" };
}

// ── Aritmética de horário ──

/**
 * Instante em que a geração por IA deve rodar para um slot que dispara em
 * `runAt`. Nunca antes de "agora" na prática — quem chama compara com o
 * relógio; aqui é só subtração.
 */
export function generateAtFor(runAt: number, generateMinutesBefore: number): number {
  const minutes = Number.isFinite(generateMinutesBefore) ? Math.max(0, generateMinutesBefore) : 0;
  return runAt - minutes * 60_000;
}

// ── Linha do tempo ──

export interface PostTimelineEntry {
  at: number;
  kind: string;
  detail?: string;
  actorId?: unknown;
  slotKey?: string;
  sends?: unknown[];
}

/** Anexa à linha do tempo mantendo o teto (FIFO, os mais antigos caem). */
export function appendPostTimeline<T extends PostTimelineEntry>(
  current: readonly T[] | undefined,
  entry: T
): T[] {
  const next = [...(current ?? []), entry];
  return next.length > POST_TIMELINE_CAP ? next.slice(next.length - POST_TIMELINE_CAP) : next;
}

/** Chave do dia UTC usada nos contadores por canal (mesma de campaignPacing). */
export function utcDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Teto diário por canal: `true` quando a publicação NÃO pode disparar agora.
 * Contador zerado ao virar o dia UTC (o mesmo critério dos tetos de campanha —
 * fuso do cliente aqui só adiantaria ou atrasaria a virada em poucas horas).
 */
export function dailyPostCapReached(
  counter: { day: string; sent: number } | undefined | null,
  now: number,
  cap: number = MAX_POSTS_PER_CHANNEL_PER_DAY
): boolean {
  if (!counter) return false;
  if (counter.day !== utcDayKey(now)) return false;
  return counter.sent >= cap;
}

/** Contador do dia depois de mais um disparo. */
export function bumpDailyPostCounter(
  counter: { day: string; sent: number } | undefined | null,
  now: number
): { day: string; sent: number } {
  const day = utcDayKey(now);
  return counter && counter.day === day ? { day, sent: counter.sent + 1 } : { day, sent: 1 };
}
