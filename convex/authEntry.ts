// Entrada unificada (/entrar): um campo de e-mail decide o passo seguinte no mesmo
// cartão (senha de quem já tem conta, criar senha de quem não tem).
//
// Pública e SEM auth por natureza (o visitante ainda não entrou). Decisão D16 do plano
// landing + onboarding v2: aceitar revelar se a conta existe, com rate limit, e a resposta
// é só `{ next }` (nem nome, nem org, nem método). Login, cadastro e reset continuam no
// provider Password (`convex/auth.ts`); esta função não cria nem altera conta.
//
// Mutation (e não query) para poder CONTAR: janelas fixas em `authEmailThrottle`, por e-mail
// e um teto global. Por IP não dá: mutation do Convex não recebe o IP do chamador. O limite
// por IP (e o Turnstile, decisão D10) exigem mover a checagem para uma rota HTTP, como
// `onboardingHttp.ts` faz com `normalizeIpKey` (docs/architecture/auth-multi-org.md).
import { ConvexError, v } from "convex/values";
import { mutation, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { resolvePasswordAccount } from "./authHelpers";
import { normalizeEmail, maskEmailForLog } from "./lib/emailAddress";
import { evaluateFixedWindow } from "./lib/onboardingBudget";
import {
  SIGNIN_CHECK_GLOBAL,
  SIGNIN_CHECK_GLOBAL_KEY,
  SIGNIN_CHECK_INVALID_EMAIL_MESSAGE,
  SIGNIN_CHECK_MAX_EMAIL_LENGTH,
  SIGNIN_CHECK_PER_EMAIL,
  SIGNIN_CHECK_RATE_LIMITED_MESSAGE,
  SIGNIN_CHECK_WINDOW_MS,
  signInCheckEmailKey,
} from "./lib/signInCheck";

type WindowPlan = { key: string; rowId: Id<"authEmailThrottle"> | null; next: { windowStart: number; count: number } };

async function planWindow(
  ctx: MutationCtx,
  key: string,
  limit: number,
  now: number,
): Promise<{ allowed: boolean; plan: WindowPlan }> {
  const row = await ctx.db
    .query("authEmailThrottle")
    .withIndex("by_email", (q) => q.eq("email", key))
    .first();
  const decision = evaluateFixedWindow(
    row ? { windowStart: row.windowStart, count: row.count } : null,
    now,
    { windowMs: SIGNIN_CHECK_WINDOW_MS, limit },
  );
  return { allowed: decision.allowed, plan: { key, rowId: row?._id ?? null, next: decision.next } };
}

export const checkEmailForSignIn = mutation({
  args: { email: v.string() },
  returns: v.object({ next: v.union(v.literal("password"), v.literal("signup")) }),
  handler: async (ctx, args) => {
    // Mesma normalização do login (`withCanonicalEmail` → `resolvePasswordAccount`).
    // Formato não é validado aqui: há contas antigas fora do padrão que ainda entram.
    const email = normalizeEmail(args.email);
    if (!email || email.length > SIGNIN_CHECK_MAX_EMAIL_LENGTH) {
      throw new ConvexError({ code: "invalid_email", message: SIGNIN_CHECK_INVALID_EMAIL_MESSAGE });
    }

    // Avalia as duas janelas antes de gravar: recusa não consome cota de nenhuma.
    const now = Date.now();
    const perEmail = await planWindow(ctx, signInCheckEmailKey(email), SIGNIN_CHECK_PER_EMAIL, now);
    const global = await planWindow(ctx, SIGNIN_CHECK_GLOBAL_KEY, SIGNIN_CHECK_GLOBAL, now);
    if (!perEmail.allowed || !global.allowed) {
      console.warn(
        `[auth] checkEmailForSignIn: teto ${perEmail.allowed ? "global" : "por e-mail"} atingido (${maskEmailForLog(email)})`,
      );
      throw new ConvexError({ code: "rate_limited", message: SIGNIN_CHECK_RATE_LIMITED_MESSAGE });
    }
    for (const { plan } of [perEmail, global]) {
      if (plan.rowId) {
        await ctx.db.patch(plan.rowId, plan.next);
      } else {
        await ctx.db.insert("authEmailThrottle", { email: plan.key, ...plan.next });
      }
    }

    const { exists } = await resolvePasswordAccount(ctx, email);
    return { next: exists ? ("password" as const) : ("signup" as const) };
  },
});
