import { v } from "convex/values";
import { internalQuery, internalMutation, QueryCtx, MutationCtx } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { normalizeEmail } from "./lib/emailAddress";

// ── Lookup de e-mail sem distinção de caixa, também para dado ANTIGO ──
// Desde a normalização tudo é gravado minúsculo, mas contas antigas guardam o
// e-mail como foi digitado ("Eric@X.com"). Os índices são por igualdade exata,
// então a busca varre só as faixas do índice cujo PREFIXO é uma variante de
// caixa dos 3 primeiros caracteres (≤ 8 faixas estreitas) e compara o resto
// normalizado — acha "Eric@X.com", "ERIC@x.com"… sem ler a tabela inteira e
// sem depender de backfill.
const CASE_PREFIX_LEN = 3;
const RANGE_TAKE = 200;

function casePrefixes(normalized: string): string[] {
  let prefixes = [""];
  for (const ch of normalized.slice(0, CASE_PREFIX_LEN)) {
    const variants = Array.from(new Set([ch, ch.toUpperCase()]));
    prefixes = prefixes.flatMap((p) => variants.map((c) => p + c));
  }
  return prefixes;
}

/** Contas do provider Password cujo e-mail é o mesmo, em qualquer caixa. */
export async function findPasswordAccountsAnyCase(
  ctx: QueryCtx | MutationCtx,
  rawEmail: string,
): Promise<Doc<"authAccounts">[]> {
  const normalized = normalizeEmail(rawEmail);
  if (!normalized) return [];
  const found: Doc<"authAccounts">[] = [];
  for (const prefix of casePrefixes(normalized)) {
    const rows = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) =>
        q
          .eq("provider", "password")
          .gte("providerAccountId", prefix)
          .lt("providerAccountId", prefix + "\uffff")
      )
      .take(RANGE_TAKE);
    for (const row of rows) {
      if (normalizeEmail(row.providerAccountId) === normalized) found.push(row);
    }
  }
  return found;
}

/** Usuários cujo e-mail é o mesmo, em qualquer caixa. */
async function findUsersAnyCase(
  ctx: QueryCtx | MutationCtx,
  rawEmail: string,
): Promise<Doc<"users">[]> {
  const normalized = normalizeEmail(rawEmail);
  if (!normalized) return [];
  const found: Doc<"users">[] = [];
  for (const prefix of casePrefixes(normalized)) {
    const rows = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.gte("email", prefix).lt("email", prefix + "\uffff"))
      .take(RANGE_TAKE);
    for (const row of rows) {
      if (normalizeEmail(row.email) === normalized) found.push(row);
    }
  }
  return found;
}

/**
 * Entre variantes, a preferida: a forma digitada EXATA; senão a minúscula;
 * senão a mais antiga. (Com 2+ variantes existe colisão legada — o backfill a
 * reporta; aqui só não podemos trancar ninguém fora da conta que digitou.)
 */
function pickPreferred<T extends { _creationTime: number }>(
  rows: T[],
  emailOf: (row: T) => string | undefined,
  rawEmail: string,
): T | null {
  if (rows.length === 0) return null;
  const typed = rawEmail.trim();
  return (
    rows.find((r) => emailOf(r) === typed) ??
    rows.find((r) => emailOf(r) === normalizeEmail(rawEmail)) ??
    [...rows].sort((a, b) => a._creationTime - b._creationTime)[0]
  );
}

// Internal query: find user by email (qualquer caixa). Prefere o usuário dono
// de conta Password — é essa que o login encontra.
export const queryUserByEmail = internalQuery({
  args: { email: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const account = pickPreferred(
      await findPasswordAccountsAnyCase(ctx, args.email),
      (a) => a.providerAccountId,
      args.email,
    );
    if (account) return await ctx.db.get(account.userId);
    return pickPreferred(await findUsersAnyCase(ctx, args.email), (u) => u.email, args.email);
  },
});

// Qual `providerAccountId` do provider Password corresponde ao e-mail digitado
// no login/cadastro/reset (ver `withCanonicalEmail` em auth.ts): a conta que
// JÁ existe em qualquer caixa (preferindo a digitada exata), senão a forma
// minúscula. `exists` diz ao cadastro público que há conta — aí ele recusa em
// vez de criar uma segunda que tomaria o login da antiga.
export const resolvePasswordAccountEmail = internalQuery({
  args: { email: v.string() },
  returns: v.object({ email: v.string(), exists: v.boolean() }),
  handler: async (ctx, args) => {
    const account = pickPreferred(
      await findPasswordAccountsAnyCase(ctx, args.email),
      (a) => a.providerAccountId,
      args.email,
    );
    return account
      ? { email: account.providerAccountId, exists: true }
      : { email: normalizeEmail(args.email), exists: false };
  },
});

// Internal query: get auth account (password provider) for current user
export const queryAuthAccountForCurrentUser = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    // Find the password auth account for this user
    const accounts = await ctx.db
      .query("authAccounts")
      .filter((q) =>
        q.and(
          q.eq(q.field("userId"), userId),
          q.eq(q.field("provider"), "password")
        )
      )
      .take(1);

    if (accounts.length === 0) return null;
    return { ...accounts[0], userId };
  },
});

// Internal mutation: insert a new user and their auth account
export const insertUserAndAuthAccount = internalMutation({
  args: {
    email: v.string(),
    name: v.string(),
    passwordHash: v.string(),
  },
  returns: v.object({ userId: v.id("users"), created: v.boolean() }),
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);

    // Idempotente e sem distinção de caixa: conta que já existe em QUALQUER
    // variante (inclusive legado "Eric@X.com") é devolvida como existente —
    // criar outra tomaria o login da antiga. Também cobre dois convites
    // simultâneos para o mesmo endereço.
    const existing = pickPreferred(
      await findPasswordAccountsAnyCase(ctx, args.email),
      (a) => a.providerAccountId,
      args.email,
    );
    if (existing) return { userId: existing.userId, created: false };

    // Create user record
    const userId = await ctx.db.insert("users", {
      email,
      name: args.name,
    });

    // Create auth account linked to user
    await ctx.db.insert("authAccounts", {
      userId,
      provider: "password",
      providerAccountId: email,
      secret: args.passwordHash,
    });

    return { userId, created: true };
  },
});

// Internal mutation: update the secret (password hash) on an auth account
export const patchAuthAccountSecret = internalMutation({
  args: {
    authAccountId: v.string(),
    newSecret: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.authAccountId as any, {
      secret: args.newSecret,
    } as any);
    return null;
  },
});

// Backfill SEGURO (não roda sozinho; `dryRun` é true por padrão): passa para
// minúsculas o e-mail gravado antes da normalização em `authAccounts`
// (provider password), `users` e `teamMembers`. Nada colide sem aviso: se
// houver OUTRA linha com o mesmo e-mail em qualquer caixa, a linha é só
// REPORTADA em `collisions` (id + e-mail) e fica intacta — mesclar contas é
// decisão humana. Uso:
//   npx convex run authHelpers:internalNormalizeLegacyEmails '{"table":"authAccounts"}'          # dry run
//   npx convex run authHelpers:internalNormalizeLegacyEmails '{"table":"authAccounts","dryRun":false}'
// repetindo com `cursor` enquanto `isDone` for false; depois "users" e "teamMembers".
export const internalNormalizeLegacyEmails = internalMutation({
  args: {
    table: v.union(v.literal("authAccounts"), v.literal("users"), v.literal("teamMembers")),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    dryRun: v.boolean(),
    changed: v.number(),
    collisions: v.array(v.object({ id: v.string(), email: v.string() })),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const paginationOpts = { numItems: 100, cursor: args.cursor ?? null };
    let changed = 0;
    const collisions: { id: string; email: string }[] = [];

    if (args.table === "authAccounts") {
      const page = await ctx.db.query("authAccounts").paginate(paginationOpts);
      for (const account of page.page) {
        if (account.provider !== "password") continue;
        const normalized = normalizeEmail(account.providerAccountId);
        if (normalized === account.providerAccountId) continue;
        const variants = await findPasswordAccountsAnyCase(ctx, account.providerAccountId);
        if (variants.some((other) => other._id !== account._id)) {
          collisions.push({ id: account._id, email: account.providerAccountId });
          continue;
        }
        changed++;
        if (!dryRun) await ctx.db.patch(account._id, { providerAccountId: normalized });
      }
      return { dryRun, changed, collisions, continueCursor: page.continueCursor, isDone: page.isDone };
    }

    if (args.table === "users") {
      const page = await ctx.db.query("users").paginate(paginationOpts);
      for (const user of page.page) {
        if (!user.email) continue;
        const normalized = normalizeEmail(user.email);
        if (normalized === user.email) continue;
        const variants = await findUsersAnyCase(ctx, user.email);
        if (variants.some((other) => other._id !== user._id)) {
          collisions.push({ id: user._id, email: user.email });
          continue;
        }
        changed++;
        if (!dryRun) await ctx.db.patch(user._id, { email: normalized });
      }
      return { dryRun, changed, collisions, continueCursor: page.continueCursor, isDone: page.isDone };
    }

    // teamMembers: o e-mail é rótulo do vínculo (não identidade de login) —
    // normalizar não funde nada, então não há colisão a reportar.
    const page = await ctx.db.query("teamMembers").paginate(paginationOpts);
    for (const member of page.page) {
      if (!member.email) continue;
      const normalized = normalizeEmail(member.email);
      if (normalized === member.email) continue;
      changed++;
      if (!dryRun) await ctx.db.patch(member._id, { email: normalized });
    }
    return { dryRun, changed, collisions, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});
