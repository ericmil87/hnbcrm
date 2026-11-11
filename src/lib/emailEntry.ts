/**
 * Regras puras da entrada unificada por e-mail (`components/auth/EmailEntryCard.tsx`).
 * Passo 1: e-mail → `authEntry.checkEmailForSignIn` responde `{ next }`; passo 2, no mesmo
 * cartão: senha (conta existente) ou criar senha (conta nova).
 */
import { ConvexError } from "convex/values";
import type { SignInCheckNext } from "../../convex/lib/signInCheck";
import type { AuthFlow } from "@/lib/authEntry";

export type { SignInCheckNext };

export type EmailEntryStep = "email" | "password" | "signup";

/** Mesma regra do provider Password (`validateDefaultPasswordRequirements`: ≥ 8). */
export const MIN_PASSWORD_LENGTH = 8;

export function stepForNext(next: SignInCheckNext): Exclude<EmailEntryStep, "email"> {
  return next === "password" ? "password" : "signup";
}

export function flowForStep(step: Exclude<EmailEntryStep, "email">): AuthFlow {
  return step === "password" ? "signIn" : "signUp";
}

/** Só o essencial (algo@algo.algo, sem espaço): o servidor aceita contas antigas fora do padrão no login. */
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emailFieldError(raw: string): string | null {
  const email = raw.trim();
  if (!email) return "Digite seu e-mail.";
  if (email.length > 254 || !EMAIL_LIKE.test(email)) return "Confira o e-mail: algo como nome@empresa.com.";
  return null;
}

export function currentPasswordError(password: string): string | null {
  return password ? null : "Digite sua senha.";
}

export function newPasswordError(password: string): string | null {
  if (!password) return "Crie uma senha.";
  if (password.length < MIN_PASSWORD_LENGTH) return `A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  return null;
}

/** `{ code, message }` de um `ConvexError` (o objeto chega pronto no cliente; aceita também JSON em texto). */
export function convexErrorData(error: unknown): { code?: string; message?: string } | null {
  if (!(error instanceof ConvexError)) return null;
  const raw: unknown = error.data;
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return { message: raw };
    }
    if (!data || typeof data !== "object") return { message: raw };
  }
  if (data && typeof data === "object") {
    const { code, message } = data as { code?: unknown; message?: unknown };
    return {
      code: typeof code === "string" ? code : undefined,
      message: typeof message === "string" ? message : undefined,
    };
  }
  return null;
}

export function isNetworkError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return ["failed to fetch", "network", "offline", "timed out", "timeout"].some((m) => message.includes(m));
}

export const NETWORK_ERROR_MESSAGE = "Sem conexão com o servidor. Confira sua internet e tente de novo.";

export interface CheckErrorView {
  message: string;
  /** Teto da checagem: a tela oferece escolher o caminho à mão. */
  rateLimited: boolean;
}

export function checkErrorView(error: unknown): CheckErrorView {
  const data = convexErrorData(error);
  if (data?.code === "rate_limited") {
    return {
      message: data.message ?? "Muitas tentativas agora. Aguarde alguns minutos ou escolha abaixo se já tem conta.",
      rateLimited: true,
    };
  }
  if (data?.message) return { message: data.message, rateLimited: false };
  if (isNetworkError(error)) return { message: NETWORK_ERROR_MESSAGE, rateLimited: false };
  return { message: "Não foi possível continuar. Tente de novo.", rateLimited: false };
}

/** Mensagem do passo 2 (entrar ou criar conta). Mensagem de `ConvexError` do servidor vence. */
export function passwordStepErrorMessage(error: unknown, step: Exclude<EmailEntryStep, "email">): string {
  const data = convexErrorData(error);
  if (data?.message) return data.message;
  if (isNetworkError(error)) return NETWORK_ERROR_MESSAGE;
  const raw = error instanceof Error ? error.message : "";
  if (step === "password") return "Senha incorreta. Tente de novo ou use \"Esqueci a senha\".";
  if (raw.includes("Invalid password")) {
    return `A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  }
  return "Não foi possível criar a conta. Tente de novo.";
}
