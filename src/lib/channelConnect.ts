/**
 * Lógica pura da conexão de número do WhatsApp por QR code (`ChannelConnectCard`):
 * modo padrão por tela, formato do código de conexão e janelas de tempo do poll.
 * Sem React nem Convex, para o wizard de configuração inicial poder reaproveitar.
 */

export type ConnectMode = "code" | "qr";

/** Celular ou tela estreita: o padrão é o código de conexão (não precisa de outro aparelho para ler o QR). */
export const CONNECT_NARROW_QUERY = "(max-width: 640px), (pointer: coarse)";

/** Intervalo entre consultas do estado da conexão. */
export const PAIRING_POLL_INTERVAL_MS = 4000;
/** O código vale por cerca de 2 minutos. */
export const CODE_VALID_MS = 120_000;
/** Depois disso o botão "Gerar outro código" fica disponível. */
export const CODE_REGENERATE_AFTER_MS = 150_000;
/** Para de consultar o código depois de 3 minutos. */
export const CODE_POLL_MAX_MS = 180_000;

/** Modo padrão: código no celular, QR no computador. */
export function defaultConnectMode(narrowOrCoarse: boolean): ConnectMode {
  return narrowOrCoarse ? "code" : "qr";
}

/** `ABCD1234` vira `ABCD-1234`. Se não tiver 8 caracteres, devolve só limpo e em maiúsculas. */
export function formatLinkingCode(raw: string): string {
  const clean = raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (clean.length !== 8) return clean;
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

/** Segundos que faltam para o código vencer (nunca negativo). */
export function codeSecondsLeft(elapsedMs: number): number {
  return Math.max(0, Math.ceil((CODE_VALID_MS - elapsedMs) / 1000));
}

/** `m:ss` para a contagem regressiva. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "Gerar outro código" só depois de 150 s do pedido. */
export function canRequestNewCode(elapsedMs: number): boolean {
  return elapsedMs >= CODE_REGENERATE_AFTER_MS;
}

/** O poll do código expira em 3 minutos. */
export function codePollExpired(elapsedMs: number): boolean {
  return elapsedMs >= CODE_POLL_MAX_MS;
}

/** Mantém o último código entre polls (o poll de código não o reenvia). */
export function keepLinkingCode(previous: string | undefined, next: string | undefined): string | undefined {
  return next && next.length > 0 ? next : previous;
}
