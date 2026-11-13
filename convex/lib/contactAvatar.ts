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

export type AvatarSlot = { runAt: number; nextFetchAt: number } | null;

/**
 * Reserva o próximo horário livre do canal. `null` = canal pausado por 429 ou
 * fila acima de 10 min (o próximo gatilho tenta de novo).
 */
export function planAvatarSlot(
  pacing: { nextFetchAt: number; pausedUntil?: number } | null | undefined,
  now: number,
  rand: number
): AvatarSlot {
  if (pacing?.pausedUntil !== undefined && pacing.pausedUntil > now) return null;
  const runAt = Math.max(now, pacing?.nextFetchAt ?? 0);
  if (runAt - now > AVATAR_MAX_QUEUE_MS) return null;
  return { runAt, nextFetchAt: runAt + avatarGapMs(rand) };
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
