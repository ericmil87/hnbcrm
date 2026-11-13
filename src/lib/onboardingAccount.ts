/**
 * Regras puras do cartão de conta do onboarding (código de e-mail) e do aceite
 * de IA/LGPD: mensagens PT-BR por `reason` das mutations de
 * `convex/emailVerification.ts`, normalização do código de 6 dígitos e espera
 * para reenviar (`canResendAt` é do servidor; o relógio é do cliente).
 */

export type RequestReason = "already_verified" | "cooldown" | "rate_limited" | "not_deliverable";
export type ConfirmReason = "wrong" | "expired" | "locked" | "none";

export const EMAIL_CODE_LENGTH = 6;

/** Só dígitos, no máximo 6 (cola "123 456" ou "123-456" sem problema). */
export function normalizeEmailCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, EMAIL_CODE_LENGTH);
}

export function isEmailCodeComplete(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/** Segundos até poder reenviar (0 = já pode). */
export function resendWaitSeconds(canResendAt: number | undefined, now: number): number {
  if (typeof canResendAt !== "number") return 0;
  return Math.max(0, Math.ceil((canResendAt - now) / 1000));
}

export function requestResultMessage(result: { sent: boolean; reason?: RequestReason }, maskedEmail?: string | null): string {
  if (result.sent) return `${emailCodeSentLine(maskedEmail)} Ele vale por alguns minutos.`;
  switch (result.reason) {
    case "already_verified":
      return "Seu e-mail já está confirmado.";
    case "cooldown":
      return "O código já foi enviado. Espere um pouco para pedir outro.";
    case "rate_limited":
      return "Muitos pedidos de código. Tente de novo mais tarde.";
    case "not_deliverable":
      return "Não conseguimos enviar para o e-mail da conta. Confira o endereço e tente de novo.";
    default:
      return "Não foi possível enviar o código. Tente de novo.";
  }
}

export function confirmResultMessage(result: { verified: boolean; reason?: ConfirmReason; attemptsLeft?: number }): string {
  if (result.verified) return "E-mail confirmado.";
  switch (result.reason) {
    case "wrong": {
      const left = result.attemptsLeft;
      return typeof left === "number" && left > 0
        ? `Código incorreto. ${left === 1 ? "Resta 1 tentativa" : `Restam ${left} tentativas`}.`
        : "Código incorreto.";
    }
    case "expired":
      return "O código venceu. Peça um novo.";
    case "locked":
      return "Muitas tentativas erradas. Peça um novo código.";
    case "none":
      return "Peça um código para confirmar o e-mail.";
    default:
      return "Não foi possível confirmar o código. Tente de novo.";
  }
}

/** Reenvio automático do código: vale uma vez por sessão (o servidor também é idempotente). */
const ensureCodeCalls = new Map<string, Promise<unknown>>();

/**
 * Executa `run` no máximo UMA vez por chave (sessão), mesmo com StrictMode e
 * remontagens (dois cartões de e-mail na conversa). Devolve a mesma promessa.
 */
export function ensureOncePerKey<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = ensureCodeCalls.get(key);
  if (existing) return existing as Promise<T>;
  const promise = run().catch((err) => {
    // Falhou: libera para uma nova tentativa (o botão "Reenviar" continua valendo).
    ensureCodeCalls.delete(key);
    throw err;
  });
  ensureCodeCalls.set(key, promise);
  return promise;
}

/** Só para testes. */
export function resetEnsureOnceForTests(): void {
  ensureCodeCalls.clear();
  notified.clear();
}

const notified = new Set<string>();

/** Marca `chave` como avisada; `true` só na primeira vez (aviso `email_verified` uma vez por sessão). */
export function markNotifiedOnce(key: string): boolean {
  if (notified.has(key)) return false;
  notified.add(key);
  return true;
}

export type EnsureReason = "already_verified" | "already_requested" | "cooldown" | "rate_limited" | "not_deliverable" | "unavailable";

/** "Te mandei um código de 6 dígitos em bu…@…" (cartão compacto do começo da conversa). */
export function emailCodeSentLine(maskedEmail: string | null | undefined): string {
  return maskedEmail
    ? `Enviamos um código de 6 dígitos para ${maskedEmail}.`
    : "Enviamos um código de 6 dígitos para o e-mail da sua conta.";
}

export function emailIntroLine(maskedEmail: string | null | undefined): string {
  return maskedEmail
    ? `Te mandei um código de 6 dígitos em ${maskedEmail}; quando chegar, é só colar aqui. Enquanto isso, me conta do seu negócio.`
    : "Te mandei um código de 6 dígitos no seu e-mail; quando chegar, é só colar aqui. Enquanto isso, me conta do seu negócio.";
}

/** O código não trava a conversa: dito no cartão, para a pessoa não ficar esperando. */
export const EMAIL_CODE_OPTIONAL_LINE =
  "Pode seguir conversando; o código só é necessário para eu ler site, PDF, imagem ou áudio.";

/** Linha recolhida do cartão de e-mail (depois da primeira resposta da pessoa). */
export const EMAIL_PENDING_LINE = "E-mail por confirmar";

/** Mensagem de quando o envio automático não saiu (o botão de reenviar fica à vista). */
export function ensureResultMessage(r: { sent: boolean; reason?: EnsureReason }): string | null {
  if (r.sent) return null;
  switch (r.reason) {
    case "already_verified":
    case "already_requested":
    case "cooldown":
      return null;
    case "rate_limited":
      return "Muitos pedidos de código. Tente de novo mais tarde.";
    case "not_deliverable":
      return "Não conseguimos enviar para o e-mail da conta. Confira o endereço da conta.";
    default:
      return "Não consegui enviar o código agora. Toque em reenviar.";
  }
}
