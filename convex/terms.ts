/**
 * Aceite dos Termos de Uso (7b). `termsAcceptances` é APPEND-ONLY: só há insert,
 * nenhuma função atualiza ou apaga uma linha (prova de consentimento).
 * Escritores: `acceptTerms` (aqui) e `createOrganization` (via `recordTermsAcceptance`).
 */
import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { isAcceptableSignupVersion, isAtLeastVersion, TERMS_MIN_ACCEPTED_VERSION, TERMS_USER_AGENT_MAX, TERMS_VERSION } from "./lib/terms";

const WRONG_VERSION =
  "Os Termos de Uso foram atualizados. Recarregue a página para ler a versão atual antes de aceitar.";

export function assertCurrentTermsVersion(version: string): void {
  if (version !== TERMS_VERSION) throw new ConvexError(WRONG_VERSION);
}

/** Cadastro de org: aceita qualquer versão entre a mínima e a vigente (grava a recebida). */
export function assertSignupTermsVersion(version: string): void {
  if (!isAcceptableSignupVersion(version)) throw new ConvexError(WRONG_VERSION);
}

/** Última versão aceita pelo usuário (a mais recente por ordem de gravação). */
async function latestAcceptedVersion(ctx: QueryCtx, userId: Id<"users">): Promise<string | null> {
  const row = await ctx.db
    .query("termsAcceptances")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .order("desc")
    .first();
  return row?.version ?? null;
}

/**
 * Registra o aceite (idempotente por usuário + versão: um segundo aceite da mesma
 * versão não grava outra linha). Quem chama já validou a versão.
 */
export async function recordTermsAcceptance(
  ctx: MutationCtx,
  args: { userId: Id<"users">; version: string; organizationId?: Id<"organizations">; userAgent?: string; now: number }
): Promise<{ inserted: boolean }> {
  const existing = await ctx.db
    .query("termsAcceptances")
    .withIndex("by_user_and_version", (q) => q.eq("userId", args.userId).eq("version", args.version))
    .first();
  if (existing) return { inserted: false };
  const userAgent = args.userAgent?.slice(0, TERMS_USER_AGENT_MAX);
  await ctx.db.insert("termsAcceptances", {
    userId: args.userId,
    version: args.version,
    acceptedAt: args.now,
    ...(args.organizationId ? { organizationId: args.organizationId } : {}),
    ...(userAgent ? { userAgent } : {}),
  });
  return { inserted: true };
}

export const getMyTermsStatus = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      currentVersion: v.string(),
      acceptedVersion: v.union(v.string(), v.null()),
      minAcceptedVersion: v.string(),
      textVersion: v.string(),
    })
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const acceptedVersion = await latestAcceptedVersion(ctx, userId);
    // `currentVersion` é "a versão que o cliente precisa aceitar para o banner sumir".
    // Bundles antigos (PWA) comparam só `acceptedVersion !== currentVersion`: quem já
    // cumpre o mínimo recebe `currentVersion = acceptedVersion`, então o banner some em
    // qualquer bundle. Quem não cumpre recebe a versão do texto. `textVersion` é a
    // versão do texto vigente (informativa; é a que o aceite grava).
    const satisfied = acceptedVersion !== null && isAtLeastVersion(acceptedVersion, TERMS_MIN_ACCEPTED_VERSION);
    return {
      currentVersion: satisfied ? acceptedVersion : TERMS_VERSION,
      acceptedVersion,
      minAcceptedVersion: TERMS_MIN_ACCEPTED_VERSION,
      textVersion: TERMS_VERSION,
    };
  },
});

export const acceptTerms = mutation({
  args: { version: v.string(), userAgent: v.optional(v.string()) },
  returns: v.object({ version: v.string(), alreadyAccepted: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Entre na sua conta para aceitar os Termos de Uso.");
    assertCurrentTermsVersion(args.version);
    const { inserted } = await recordTermsAcceptance(ctx, {
      userId,
      version: args.version,
      userAgent: args.userAgent,
      now: Date.now(),
    });
    return { version: args.version, alreadyAccepted: !inserted };
  },
});
