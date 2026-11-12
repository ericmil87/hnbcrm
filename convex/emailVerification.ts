// Confirmação de e-mail por código de 6 dígitos (onboarding v2, decisão D2).
// Só age quando o usuário pede; nada no login nem em fluxo existente exige isto.
// A porta de leitura é `isEmailVerifiedForMaterials` (lib/emailVerification.ts).
import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { sendTransactionalEmail } from "./email";
import { buildEmailVerificationTemplate } from "./authEmailTemplates";
import { requireAccountWithEmail } from "./lib/auth";
import { cronsDisabled } from "./lib/cronGuard";
import { internal } from "./_generated/api";
import { maskEmailForDisplay, maskEmailForLog, normalizeEmail } from "./lib/emailAddress";
import {
  EMAIL_CODE_DAY_MS,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_MAX_FAILURES_PER_DAY,
  EMAIL_CODE_REQUESTS_PER_DAY,
  emailCodeSecretMaterial,
  EMAIL_CODE_REQUESTS_PER_HOUR,
  EMAIL_CODE_RESEND_COOLDOWN_MS,
  EMAIL_CODE_TTL_MINUTES,
  EMAIL_CODE_TTL_MS,
  EMAIL_CODE_WINDOW_MS,
  constantTimeEqual,
  generateEmailVerificationCode,
  hashEmailVerificationCode,
} from "./lib/emailVerification";

const PRUNE_BATCH = 200;

/** Conta um pedido numa janela fixa de `authEmailThrottle`; false = teto atingido. */
async function checkWindow(
  ctx: MutationCtx,
  key: string,
  now: number,
  commit: boolean,
  limit: number = EMAIL_CODE_REQUESTS_PER_HOUR,
  windowMs: number = EMAIL_CODE_WINDOW_MS,
): Promise<boolean> {
  const row = await ctx.db
    .query("authEmailThrottle")
    .withIndex("by_email", (q) => q.eq("email", key))
    .first();
  if (!row || now - row.windowStart >= windowMs) {
    if (commit) {
      if (row) await ctx.db.patch(row._id, { windowStart: now, count: 1 });
      else await ctx.db.insert("authEmailThrottle", { email: key, windowStart: now, count: 1 });
    }
    return true;
  }
  if (row.count >= limit) return false;
  if (commit) await ctx.db.patch(row._id, { count: row.count + 1 });
  return true;
}

/** Soma um erro de código na janela de 24 h do usuário (chave `verify-fail:`). */
async function bumpFailure(ctx: MutationCtx, userId: Id<"users">, now: number) {
  await checkWindow(ctx, `verify-fail:${userId}`, now, true, Number.MAX_SAFE_INTEGER, EMAIL_CODE_DAY_MS);
}

async function auditVerification(ctx: MutationCtx, userId: Id<"users">, description: string, severity: "low" | "medium") {
  // O usuário pode ainda não ter organização (conta antes da org): sem org não há onde gravar.
  const memberships = await ctx.db
    .query("teamMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(5);
  const now = Date.now();
  for (const m of memberships) {
    if (m.type !== "human") continue;
    await ctx.db.insert("auditLogs", {
      organizationId: m.organizationId,
      entityType: "user",
      entityId: userId,
      action: "update",
      actorId: m._id,
      actorType: "human",
      description,
      severity,
      createdAt: now,
    });
  }
}

export type RequestCodeResult = {
  sent: boolean;
  reason?: "already_verified" | "cooldown" | "rate_limited" | "not_deliverable" | "unavailable";
  canResendAt?: number;
  expiresAt?: number;
};

/**
 * Núcleo do pedido de código (mesmos limites para o clique e para o envio
 * automático do onboarding): 60 s entre pedidos, 5/h e 10/dia por usuário e por
 * endereço, bloqueio por erros, segredo obrigatório. Nunca lança: `unavailable`
 * = sem segredo de código configurado.
 */
export async function requestEmailVerificationCodeCore(
  ctx: MutationCtx,
  user: Doc<"users">,
): Promise<RequestCodeResult> {
  const userId = user._id;
  if (typeof user.emailVerificationTime === "number") return { sent: false, reason: "already_verified" };

  if (!emailCodeSecretMaterial()) {
    console.error("[email] emailVerification: sem JWT_PRIVATE_KEY nem EMAIL_CODE_PEPPER — pedido recusado");
    return { sent: false, reason: "unavailable" };
  }

  const now = Date.now();
  const email = normalizeEmail(user.email);
  const previous = await ctx.db
    .query("emailVerificationCodes")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .order("desc")
    .first();
  if (previous && now - previous.createdAt < EMAIL_CODE_RESEND_COOLDOWN_MS) {
    return { sent: false, reason: "cooldown", canResendAt: previous.createdAt + EMAIL_CODE_RESEND_COOLDOWN_MS };
  }
  const userKey = `verify-user:${userId}`;
  const emailKey = `verify-email:${email}`;
  // Avalia os dois antes de gravar: recusa não consome cota de nenhum.
  const userDayKey = `verify-user-d:${userId}`;
  const emailDayKey = `verify-email-d:${email}`;
  const okUser = await checkWindow(ctx, userKey, now, false);
  const okEmail = await checkWindow(ctx, emailKey, now, false);
  const okUserDay = await checkWindow(ctx, userDayKey, now, false, EMAIL_CODE_REQUESTS_PER_DAY, EMAIL_CODE_DAY_MS);
  const okEmailDay = await checkWindow(ctx, emailDayKey, now, false, EMAIL_CODE_REQUESTS_PER_DAY, EMAIL_CODE_DAY_MS);
  // Erros demais de código em 24 h: bloqueia novos pedidos até a janela fechar.
  const failures = await ctx.db
    .query("authEmailThrottle")
    .withIndex("by_email", (q) => q.eq("email", `verify-fail:${userId}`))
    .first();
  const blockedByFailures =
    !!failures && now - failures.windowStart < EMAIL_CODE_DAY_MS && failures.count >= EMAIL_CODE_MAX_FAILURES_PER_DAY;
  if (!okUser || !okEmail || !okUserDay || !okEmailDay || blockedByFailures) {
    console.warn(`[email] emailVerification: teto de pedidos atingido para ${maskEmailForLog(email)}`);
    return { sent: false, reason: "rate_limited" };
  }

  const code = generateEmailVerificationCode();
  const template = buildEmailVerificationTemplate({ code, expiresMinutes: EMAIL_CODE_TTL_MINUTES });
  const delivered = await sendTransactionalEmail(ctx, {
    to: email,
    subject: template.subject,
    html: template.html,
    kind: "emailVerification",
  });
  if (!delivered) return { sent: false, reason: "not_deliverable" };

  await checkWindow(ctx, userKey, now, true);
  await checkWindow(ctx, emailKey, now, true);
  await checkWindow(ctx, userDayKey, now, true, EMAIL_CODE_REQUESTS_PER_DAY, EMAIL_CODE_DAY_MS);
  await checkWindow(ctx, emailDayKey, now, true, EMAIL_CODE_REQUESTS_PER_DAY, EMAIL_CODE_DAY_MS);
  const old = await ctx.db
    .query("emailVerificationCodes")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(20);
  for (const row of old) await ctx.db.delete(row._id);
  const expiresAt = now + EMAIL_CODE_TTL_MS;
  await ctx.db.insert("emailVerificationCodes", {
    userId,
    codeHash: await hashEmailVerificationCode(userId, email, code),
    expiresAt,
    attempts: 0,
    createdAt: now,
  });
  return { sent: true, canResendAt: now + EMAIL_CODE_RESEND_COOLDOWN_MS, expiresAt };
}

export const requestEmailVerificationCode = mutation({
  args: {},
  returns: v.object({
    sent: v.boolean(),
    reason: v.optional(
      v.union(v.literal("already_verified"), v.literal("cooldown"), v.literal("rate_limited"), v.literal("not_deliverable")),
    ),
    canResendAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
  }),
  handler: async (ctx) => {
    const user = await requireAccountWithEmail(ctx);
    const r = await requestEmailVerificationCodeCore(ctx, user);
    const { reason, ...rest } = r;
    if (reason === "unavailable") {
      throw new ConvexError("A confirmação de e-mail está indisponível no momento. Tente novamente mais tarde.");
    }
    return { ...rest, ...(reason ? { reason } : {}) };
  },
});

export const confirmEmailVerificationCode = mutation({
  args: { code: v.string() },
  returns: v.object({
    verified: v.boolean(),
    reason: v.optional(v.union(v.literal("wrong"), v.literal("expired"), v.literal("locked"), v.literal("none"))),
    attemptsLeft: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    const user = await requireAccountWithEmail(ctx);
    if (typeof user.emailVerificationTime === "number") return { verified: true };

    const row = await ctx.db
      .query("emailVerificationCodes")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .first();
    if (!row) return { verified: false, reason: "none" as const };
    const now = Date.now();
    if (row.expiresAt <= now) {
      await ctx.db.delete(row._id);
      return { verified: false, reason: "expired" as const };
    }
    // Formato inválido (não são 6 dígitos) não gasta tentativa: erro de digitação, não palpite.
    const typed = args.code.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(typed)) {
      return { verified: false, reason: "wrong" as const, attemptsLeft: EMAIL_CODE_MAX_ATTEMPTS - row.attempts };
    }
    // Erro volta como resultado (não throw): o throw reverteria a contagem de tentativas.
    const attempts = row.attempts + 1;
    const given = await hashEmailVerificationCode(user._id, normalizeEmail(user.email), typed);
    if (!constantTimeEqual(given, row.codeHash)) {
      await bumpFailure(ctx, user._id, now);
      if (attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
        await ctx.db.delete(row._id);
        await auditVerification(ctx, user._id, "Código de confirmação de e-mail bloqueado após 5 erros", "medium");
        return { verified: false, reason: "locked" as const, attemptsLeft: 0 };
      }
      await ctx.db.patch(row._id, { attempts });
      return { verified: false, reason: "wrong" as const, attemptsLeft: EMAIL_CODE_MAX_ATTEMPTS - attempts };
    }
    await ctx.db.delete(row._id);
    await ctx.db.patch(user._id, { emailVerificationTime: now });
    await auditVerification(ctx, user._id, "E-mail da conta confirmado por código", "low");
    return { verified: true };
  },
});

export const getEmailVerificationStatus = query({
  args: {},
  returns: v.object({
    verified: v.boolean(),
    canResendAt: v.optional(v.number()),
    /** Endereço mascarado da conta ("bu…te@dominio.com"); ausente se não houver e-mail válido. */
    maskedEmail: v.optional(v.string()),
  }),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { verified: false };
    const user = await ctx.db.get(userId);
    if (!user) return { verified: false };
    if (typeof user.emailVerificationTime === "number") return { verified: true };
    const masked = maskEmailForDisplay(user.email);
    const maskedField = masked ? { maskedEmail: masked } : {};
    const last = await ctx.db
      .query("emailVerificationCodes")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .first();
    // Sem relógio na query: o cliente compara `canResendAt` com o próprio Date.now().
    return last
      ? { verified: false, canResendAt: last.createdAt + EMAIL_CODE_RESEND_COOLDOWN_MS, ...maskedField }
      : { verified: false, ...maskedField };
  },
});

/** Cron diário: apaga códigos vencidos (lote de 200, se reagenda enquanto houver). */
export const internalPruneEmailVerificationCodes = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    if (cronsDisabled()) return 0;
    const now = Date.now();
    const rows = await ctx.db
      .query("emailVerificationCodes")
      .withIndex("by_expires_at", (q) => q.lte("expiresAt", now))
      .take(PRUNE_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    // Contadores de janela vencidos (maior janela = 24 h; `verify-*`, `signin-check <e-mail>` e reset de senha: linha vencida = linha ausente).
    const throttles = await ctx.db
      .query("authEmailThrottle")
      .withIndex("by_window_start", (q) => q.lte("windowStart", now - EMAIL_CODE_DAY_MS))
      .take(PRUNE_BATCH);
    for (const row of throttles) await ctx.db.delete(row._id);
    if (rows.length === PRUNE_BATCH || throttles.length === PRUNE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.emailVerification.internalPruneEmailVerificationCodes, {});
    }
    return rows.length + throttles.length;
  },
});
