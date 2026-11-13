/**
 * Foto de perfil do contato — regras PURAS (sem `ctx`).
 *
 * Decisões (docs/architecture/whatsapp-bridge.md, "Foto de perfil"):
 *  - `contacts.avatarUrl` é o campo DESNORMALIZADO "o que mostrar" (a lista de
 *    conversas o lê de graça). Foto manual (`photoFileId`) vence a do WhatsApp.
 *  - O contato só é escrito quando o valor exibido muda de verdade.
 *  - Quando buscar: sem linha → busca; `ok` renova em 7 dias; `hidden`/`none` em
 *    30; `error` recua 1 h, 6 h, 24 h, depois 7 dias.
 *  - Ritmo por canal: uma busca por vez, 8–15 s de intervalo com jitter, fila
 *    de no máximo 10 min; 429 pausa o canal 15 min dobrando até 6 h.
 */

export type AvatarStatus = "ok" | "hidden" | "none" | "error";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const AVATAR_OK_RENEW_MS = 7 * DAY;
export const AVATAR_ABSENT_RENEW_MS = 30 * DAY;
export const AVATAR_ERROR_BACKOFF_MS: readonly number[] = [HOUR, 6 * HOUR, 24 * HOUR, 7 * DAY];
/** Busca pendente mais nova que isto: não agenda de novo. */
export const AVATAR_PENDING_TTL_MS = 10 * MINUTE;

export const AVATAR_GAP_MIN_MS = 8_000;
export const AVATAR_GAP_MAX_MS = 15_000;
/** Fila por canal: se o próximo horário livre está mais longe que isto, não agenda. */
export const AVATAR_MAX_QUEUE_MS = 10 * MINUTE;
export const AVATAR_PAUSE_BASE_MS = 15 * MINUTE;
export const AVATAR_PAUSE_MAX_MS = 6 * HOUR;
/** Depois de recusa por cota/contato sumido: recuo longo. */
export const AVATAR_REFUSED_BACKOFF_MS = 7 * DAY;
/** Teto de buscas de foto por canal (número) por dia UTC. */
export const AVATAR_DAILY_CAP_PER_CHANNEL = 300;
/** `error` SEGUIDOS no canal que o pausam (mesma escada do 429). */
export const AVATAR_ERROR_STREAK_LIMIT = 5;
/** Canal sem URL/token, inativo ou com sessão caída: não reagenda a cada mensagem. */
export const AVATAR_CONFIG_SKIP_BACKOFF_MS = HOUR;
/** Canal que não é bridge (ex.: Meta Cloud API): confere de novo só em 7 dias. */
export const AVATAR_NON_BRIDGE_BACKOFF_MS = 7 * DAY;

/** Kill switch: `CONTACT_AVATAR_FETCH=0` desliga o agendamento (padrão ligado). */
export function contactAvatarFetchEnabled(): boolean {
  return process.env.CONTACT_AVATAR_FETCH !== "0";
}

/** Quando a próxima conferência vence, dado o resultado desta. `failures` já inclui a atual. */
export function computeNextCheckAt(status: AvatarStatus, failures: number, now: number): number {
  switch (status) {
    case "ok":
      return now + AVATAR_OK_RENEW_MS;
    case "hidden":
    case "none":
      return now + AVATAR_ABSENT_RENEW_MS;
    case "error": {
      const i = Math.min(Math.max(failures, 1), AVATAR_ERROR_BACKOFF_MS.length) - 1;
      return now + AVATAR_ERROR_BACKOFF_MS[i];
    }
  }
}

export type AvatarSource = "whatsapp" | "instagram" | "messenger";

/** Quem obteve a foto da linha: ausente = WhatsApp (linhas anteriores ao Instagram/Messenger). */
export function avatarRowSource(row: { source?: AvatarSource }): AvatarSource {
  return row.source ?? "whatsapp";
}

/**
 * Regra entre canais (uma foto por contato): a foto `ok` de OUTRO canal ainda válida
 * (não vencida) nunca é trocada; só preenche quando não há foto, está vencida ou veio
 * do mesmo canal. E o "sem foto/oculta" de um canal não apaga a foto de outro.
 */
export function otherChannelPhotoStillValid(
  row: { status: string; url?: string; source?: AvatarSource; nextCheckAt: number },
  source: AvatarSource,
  now: number
): boolean {
  return row.status === "ok" && !!row.url && avatarRowSource(row) !== source && row.nextCheckAt > now;
}

/** Teto do arquivo da foto do Instagram/Messenger (a do WhatsApp é miniatura de ~2 KB; a da Meta vem maior). Acima disso: `error` com recuo, nada é guardado. */
export const META_AVATAR_MAX_BYTES = 500 * 1024;

export type AvatarRowState = {
  nextCheckAt: number;
  pendingSince?: number;
};

/** Deve agendar uma busca agora? (regra de vencimento) */
export function isAvatarCheckDue(row: AvatarRowState | null | undefined, now: number): boolean {
  if (!row) return true;
  if (row.pendingSince !== undefined && now - row.pendingSince < AVATAR_PENDING_TTL_MS) return false;
  return now >= row.nextCheckAt;
}

/** Telefone para o gateway: `whatsappNumber ?? phone`, só dígitos (8–15), nunca JID. */
export function avatarPhoneFor(contact: { whatsappNumber?: string; phone?: string }): string | null {
  const raw = (contact.whatsappNumber ?? contact.phone ?? "").trim();
  if (!raw || raw.includes("@")) return null; // `…@lid` não é telefone
  if (/[a-z]/i.test(raw)) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/** Intervalo entre duas buscas do mesmo canal (8–15 s). `rand` em [0,1). */
export function avatarGapMs(rand: number): number {
  const r = Math.min(Math.max(rand, 0), 0.999999);
  return AVATAR_GAP_MIN_MS + Math.floor(r * (AVATAR_GAP_MAX_MS - AVATAR_GAP_MIN_MS + 1));
}

/** Dia UTC (`YYYY-MM-DD`) do contador diário do canal. */
export function avatarDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export type AvatarPacingState = {
  nextFetchAt: number;
  pausedUntil?: number;
  day?: string;
  dayCount?: number;
};

export type AvatarSlot = { runAt: number; nextFetchAt: number; day: string; dayCount: number } | null;

/**
 * Reserva o próximo horário livre do canal. `null` = canal pausado (429 ou
 * disjuntor), teto diário (300) atingido ou fila acima de 10 min (o próximo
 * gatilho tenta de novo).
 */
export function planAvatarSlot(
  pacing: AvatarPacingState | null | undefined,
  now: number,
  rand: number
): AvatarSlot {
  if (pacing?.pausedUntil !== undefined && pacing.pausedUntil > now) return null;
  const day = avatarDayKey(now);
  const used = pacing?.day === day ? (pacing.dayCount ?? 0) : 0;
  if (used >= AVATAR_DAILY_CAP_PER_CHANNEL) return null;
  const runAt = Math.max(now, pacing?.nextFetchAt ?? 0);
  if (runAt - now > AVATAR_MAX_QUEUE_MS) return null;
  return { runAt, nextFetchAt: runAt + avatarGapMs(rand), day, dayCount: used + 1 };
}

/**
 * Teto diário e pausa do canal para a Graph (Instagram/Messenger): como
 * `planAvatarSlot`, sem fila nem intervalo. `null` = pausado ou teto atingido.
 */
export function planMetaAvatarSlot(
  pacing: AvatarPacingState | null | undefined,
  now: number
): { day: string; dayCount: number } | null {
  if (pacing?.pausedUntil !== undefined && pacing.pausedUntil > now) return null;
  const day = avatarDayKey(now);
  const used = pacing?.day === day ? (pacing.dayCount ?? 0) : 0;
  if (used >= AVATAR_DAILY_CAP_PER_CHANNEL) return null;
  return { day, dayCount: used + 1 };
}

/**
 * Um `error` do gateway no canal: conta na sequência e, no 5º seguido, pausa o
 * canal como o 429 (`strikes` sobe, mesma escada). Devolve o patch do canal.
 */
export function pacingAfterAvatarError(
  pacing: { strikes?: number; errorStreak?: number } | null | undefined,
  now: number
): { errorStreak: number; strikes?: number; pausedUntil?: number } {
  const streak = (pacing?.errorStreak ?? 0) + 1;
  if (streak < AVATAR_ERROR_STREAK_LIMIT) return { errorStreak: streak };
  const strikes = (pacing?.strikes ?? 0) + 1;
  return { errorStreak: 0, strikes, pausedUntil: now + avatarPauseMs(strikes) };
}

/** Pausa do canal por 429: 15 min, dobrando até 6 h. `strikes` já inclui este. */
export function avatarPauseMs(strikes: number): number {
  const n = Math.max(1, Math.floor(strikes));
  return Math.min(AVATAR_PAUSE_BASE_MS * 2 ** Math.min(n - 1, 10), AVATAR_PAUSE_MAX_MS);
}

/** O que mostrar: a foto manual vence; sem ela, a do WhatsApp guardada. */
export function resolveDisplayedAvatar(args: {
  manualUrl?: string | null;
  whatsappUrl?: string | null;
}): string | undefined {
  return args.manualUrl ?? args.whatsappUrl ?? undefined;
}

/**
 * Efeito de uma troca da foto do WHATSAPP no contato. Com foto manual
 * (`photoFileId`) o WhatsApp nunca sobrescreve; senão só escreve se mudou.
 */
export function whatsappAvatarContactPatch(args: {
  hasManualPhoto: boolean;
  currentAvatarUrl?: string;
  newWhatsappUrl?: string;
}): { write: boolean; avatarUrl?: string } {
  if (args.hasManualPhoto) return { write: false };
  if (args.currentAvatarUrl === args.newWhatsappUrl) return { write: false };
  return { write: true, avatarUrl: args.newWhatsappUrl };
}

/**
 * Chaves que `enrichContact` (REST/MCP, `fields` livre) NUNCA pode gravar:
 * sistema (`_id`, `organizationId`, datas), derivadas (`searchText`,
 * `enrichmentMeta`, `avatarUrl`), estado de WhatsApp (`whatsappCheck`,
 * `whatsappFails`, `whatsappLookup`) e a foto manual (`photoFileId`, que tem
 * porta própria). Qualquer chave começando por `_` ou `$` também sai.
 */
export const ENRICH_BLOCKED_FIELDS: readonly string[] = [
  "_id",
  "_creationTime",
  "organizationId",
  "avatarUrl",
  "photoFileId",
  "whatsappCheck",
  "whatsappFails",
  "whatsappLookup",
  "searchText",
  "searchNorm",
  "enrichmentMeta",
  "languageSource",
  "createdAt",
  "updatedAt",
];

export function sanitizeEnrichFields(fields: Record<string, unknown>): {
  fields: Record<string, unknown>;
  dropped: string[];
} {
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (ENRICH_BLOCKED_FIELDS.includes(key) || key.startsWith("_") || key.startsWith("$")) dropped.push(key);
    else kept[key] = value;
  }
  return { fields: kept, dropped };
}

/** Dígitos do número de envio (`whatsappNumber ?? phone`). */
function sendDigits(c: { whatsappNumber?: string; phone?: string }): string {
  return (c.whatsappNumber ?? c.phone ?? "").replace(/\D/g, "");
}

/**
 * O número do contato passou a ser de OUTRA pessoa? Mesma grafia ou outra grafia
 * BR (9º dígito) do mesmo número NÃO conta; vazio → número também conta como troca.
 * `spellings(old)` devolve as grafias do número antigo (`phoneLookupCandidates`).
 */
export function numberChangedPerson(
  before: { whatsappNumber?: string; phone?: string },
  after: { whatsappNumber?: string; phone?: string },
  spellings: (digits: string) => string[]
): boolean {
  const a = sendDigits(before);
  const b = sendDigits(after);
  if (a === b) return false;
  if (!a) return false; // não havia número: não havia foto de ninguém
  return !b || !spellings(a).includes(b);
}
