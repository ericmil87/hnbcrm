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

export function requestResultMessage(result: { sent: boolean; reason?: RequestReason }): string {
  if (result.sent) return "Enviamos um código de 6 dígitos para o e-mail da sua conta. Ele vale por alguns minutos.";
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
