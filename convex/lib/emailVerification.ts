// Confirmação de e-mail por código de 6 dígitos (onboarding v2, decisão D2).
// Regras puras e o helper único que outros módulos importam; as funções Convex
// moram em convex/emailVerification.ts.
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export const EMAIL_CODE_LENGTH = 6;
export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
export const EMAIL_CODE_TTL_MINUTES = EMAIL_CODE_TTL_MS / 60_000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
/** Intervalo mínimo entre dois pedidos do mesmo usuário. */
export const EMAIL_CODE_RESEND_COOLDOWN_MS = 60 * 1000;
/** Teto por hora, por usuário e por endereço (janela fixa em `authEmailThrottle`). */
export const EMAIL_CODE_REQUESTS_PER_HOUR = 5;
export const EMAIL_CODE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Porta única para "este usuário confirmou o e-mail?". Usada pelo onboarding
 * (P2.3) para liberar site, anexos e áudio. Lê o campo nativo do Convex Auth.
 */
export async function isEmailVerifiedForMaterials(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const user = await ctx.db.get(userId);
  return typeof user?.emailVerificationTime === "number";
}

/** 6 dígitos uniformes (rejection sampling sobre uint32: sem viés de módulo). */
export function generateEmailVerificationCode(): string {
  const limit = 4_294_000_000; // maior múltiplo de 10^6 que cabe em 2^32
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % 10 ** EMAIL_CODE_LENGTH).padStart(EMAIL_CODE_LENGTH, "0");
  }
}

/** HMAC-SHA256 hex do código; sal = userId, pepper opcional em EMAIL_CODE_PEPPER. */
export async function hashEmailVerificationCode(userId: string, code: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(process.env.EMAIL_CODE_PEPPER ?? "hnbcrm-email-code"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${userId}:${code}`));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Comparação em tempo constante de duas strings do mesmo formato. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
