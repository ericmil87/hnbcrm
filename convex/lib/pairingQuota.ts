/**
 * Teto de pareamento por código (anti-ban), compartilhado entre o Telegram
 * (`lib/telegramActions.ts`) e a web (`channelConfigs.startBridgePairing`):
 * 3 tentativas por hora por canal, janela que reinicia 1 h depois do início.
 * Puro: quem persiste a linha de `telegramReconnects` é o chamador.
 */
export const PAIRING_ATTEMPTS_PER_HOUR = 3;
export const PAIRING_WINDOW_MS = 60 * 60 * 1000;

export type PairingQuotaRow = { hourStart: number; attempts: number } | null | undefined;

/** Janela vigente (sem consumir): linha ausente ou com ≥ 1 h começa uma nova. */
export function pairingWindow(row: PairingQuotaRow, now: number): { hourStart: number; attempts: number } {
  if (!row || now - row.hourStart >= PAIRING_WINDOW_MS) return { hourStart: now, attempts: 0 };
  return { hourStart: row.hourStart, attempts: row.attempts };
}

export function consumePairingAttempt(
  row: PairingQuotaRow,
  now: number,
): {
  allowed: boolean;
  attemptsLeft: number;
  /** Quando a janela atual reinicia (libera novas tentativas). */
  resetsAt: number;
  next: { hourStart: number; attempts: number };
} {
  const win = pairingWindow(row, now);
  const resetsAt = win.hourStart + PAIRING_WINDOW_MS;
  if (win.attempts >= PAIRING_ATTEMPTS_PER_HOUR) {
    return { allowed: false, attemptsLeft: 0, resetsAt, next: win };
  }
  const attempts = win.attempts + 1;
  return {
    allowed: true,
    attemptsLeft: PAIRING_ATTEMPTS_PER_HOUR - attempts,
    resetsAt,
    next: { hourStart: win.hourStart, attempts },
  };
}
