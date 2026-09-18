// Provider de e-mail (código OTP) para o flow "reset" do Password provider
// do Convex Auth (@convex-dev/auth 0.0.80) — wired em convex/auth.ts via
// `Password({ reset: passwordResetProvider })`.
//
// Achados ao ler node_modules/@convex-dev/auth/src/providers/Password.ts:
// - `email` é exigido nos TRÊS flows relevantes (o `profile` default lê
//   `params.email` antes do switch de flow — inclusive em "reset-verification",
//   que usa esse e-mail para reidentificar a conta ao trocar a senha).
// - flow "reset" só precisa de `email` (dispara o envio do código).
// - flow "reset-verification" precisa de `email` + `code` (o `code` vira o
//   `token` do OTP, conferido por callVerifyCodeAndSignIn) + `newPassword`
//   (checado explicitamente em Password.ts; sem ele lança
//   "Missing `newPassword` param for `reset-verification` flow").
// - validação de senha default (nenhum `validatePasswordRequirements`
//   customizado foi passado): não vazia e >= 8 caracteres
//   (validateDefaultPasswordRequirements em Password.ts) — vale tanto para
//   "signUp" quanto para "reset-verification".
//
// Achado em node_modules/@convex-dev/auth/dist/server/implementation/signIn.js:78-97
// (handleEmailAndPhoneProvider): `sendVerificationRequest` é chamado com
// DOIS argumentos — `(params, ctx)` — e esse `ctx` é um ActionCtx de verdade
// (dá pra rodar ctx.runMutation). O TIPO publicado de `sendVerificationRequest`
// (herdado de @auth/core's EmailConfig) só declara UM parâmetro; como é uma
// propriedade de função (não um método), o TS aplica checagem contravariante
// estrita e recusa atribuir ali uma implementação de 2 parâmetros (confirmado
// num arquivo de teste isolado). Por isso a função é declarada à parte, com a
// assinatura REAL usada em runtime, e só a REFERÊNCIA é castada para o tipo
// exportado do pacote — nunca para `any`.
import { EmailConfig, GenericActionCtxWithAuthConfig } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { DataModel } from "./_generated/dataModel";
import { RESET_CODE_TTL_MINUTES } from "./lib/passwordResetConfig";

const RESET_CODE_LENGTH = 8;

/**
 * Código numérico de 8 dígitos, sem viés de módulo: 256 (o espaço de um
 * byte) não é múltiplo de 10, então `byte % 10` sozinho favoreceria os
 * dígitos 0-5. Descartar bytes >= 250 (o maior múltiplo de 10 que cabe em
 * 256) e sortear de novo resolve isso sem precisar de uma dependência nova.
 */
export function generateResetCode(): string {
  const digits: string[] = [];
  while (digits.length < RESET_CODE_LENGTH) {
    const batch = new Uint8Array(RESET_CODE_LENGTH - digits.length);
    crypto.getRandomValues(batch);
    for (const byte of batch) {
      if (byte >= 250) continue;
      digits.push(String(byte % 10));
    }
  }
  return digits.join("");
}

async function sendPasswordResetVerification(
  params: { identifier: string; token: string },
  ctx: GenericActionCtxWithAuthConfig<DataModel>,
): Promise<void> {
  await ctx.runMutation(internal.authEmails.sendPasswordResetCode, {
    email: params.identifier,
    code: params.token,
  });
}

// Passado a `Password({ reset: passwordResetProvider })` em convex/auth.ts.
export const passwordResetProvider: EmailConfig = {
  id: "password-reset-otp",
  type: "email",
  name: "Redefinir senha",
  maxAge: RESET_CODE_TTL_MINUTES * 60,
  generateVerificationToken: generateResetCode,
  // O `as` direto falha (TS2352: "neither type sufficiently overlaps") porque
  // as assinaturas divergem demais para o TS aceitar sem o passo por
  // `unknown` — mesmo assim, isto NUNCA vira `any`: o alvo do cast é o tipo
  // exportado de verdade (`EmailConfig["sendVerificationRequest"]`).
  sendVerificationRequest:
    sendPasswordResetVerification as unknown as EmailConfig["sendVerificationRequest"],
};
