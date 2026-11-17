/**
 * Descadastro dos e-mails de cobrança (`billingNotices`) pelo link do e-mail.
 *
 * PÚBLICO E SEM AUTH POR DESENHO: a posse do token HMAC (`lib/billingUnsub.ts`) é a credencial.
 * Regras de segurança:
 *  - a assinatura é verificada ANTES de qualquer leitura do banco;
 *  - os ids saem de dentro do token como string e passam por `ctx.db.normalizeId`;
 *  - o membro é revalidado (mesma org, humano, com `userId`, não removido) e a org precisa existir;
 *  - qualquer falha devolve o MESMO `{valid:false}` (sem enumeração de org/membro);
 *  - o token nunca vai para log, erro nem audit;
 *  - a escrita é só por `patchMemberPrefs`, sempre "set" de `channels.email.billingNotices`.
 *
 * Rota HTTP (`router.ts`): `POST /notifications/unsubscribe?t=` (one-click, RFC 8058) chama
 * `internalOneClickUnsubscribe`, que primeiro conta o pedido no teto por IP (60/h em
 * `authEmailThrottle`, chave `unsub ip:<hash>`). `GET` na mesma rota só redireciona para a página.
 */
import { v } from "convex/values";
import { httpAction, internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { isMembershipRevoked } from "./lib/auth";
import { channelAllows, type PolicyPrefs } from "./lib/notificationPolicy";
import { loadMemberPrefs, orgDefaultsOf, patchMemberPrefs } from "./lib/notificationPrefs";
import { clientIpKey, evaluateFixedWindow } from "./lib/onboardingBudget";
import {
  UNSUB_TOKEN_MAX_LEN,
  unsubIpThrottleKey,
  unsubPageUrl,
  unsubSecretsFromEnv,
  verifyUnsubToken,
} from "./lib/billingUnsub";

/** Flag de preferência da classe desativável dos avisos de cobrança. */
export const BILLING_NOTICES_FLAG = "billingNotices";
export const UNSUB_IP_LIMIT_PER_HOUR = 60;
export const UNSUB_IP_WINDOW_MS = 60 * 60 * 1000;
const THROTTLE_KEY_RE = /^unsub ip:(unknown|[0-9a-f]{16})$/;

const unsubResultValidator = v.union(
  v.object({ valid: v.literal(false) }),
  v.object({ valid: v.literal(true), orgName: v.string(), enabled: v.boolean() }),
);
type UnsubResult = { valid: false } | { valid: true; orgName: string; enabled: boolean };

/** Sempre um objeto novo e idêntico: nenhum caminho de falha devolve algo diferente. */
const invalid = (): UnsubResult => ({ valid: false });

type Target = { org: Doc<"organizations">; member: Doc<"teamMembers"> };

async function resolveTarget(ctx: { db: QueryCtx["db"] }, token: string): Promise<Target | null> {
  if (typeof token !== "string" || token.length === 0 || token.length > UNSUB_TOKEN_MAX_LEN) return null;
  // 1. Assinatura primeiro (sem segredo configurado = null). Nada do banco é lido antes.
  const claims = await verifyUnsubToken(token, unsubSecretsFromEnv());
  if (!claims) return null;
  // 2. Ids do token: string → Id da tabela certa, ou inválido.
  const organizationId = ctx.db.normalizeId("organizations", claims.organizationId);
  const memberId = ctx.db.normalizeId("teamMembers", claims.memberId);
  if (!organizationId || !memberId) return null;
  // 3. Membro vivo, humano, com conta, da MESMA org.
  const member = await ctx.db.get(memberId);
  if (
    !member ||
    member.organizationId !== organizationId ||
    member.type !== "human" ||
    !member.userId ||
    isMembershipRevoked(member)
  ) {
    return null;
  }
  const org = await ctx.db.get(organizationId);
  if (!org) return null;
  return { org, member };
}

/**
 * Estado EFETIVO do e-mail da classe, pela mesma política que o envio usa (`channelAllows`):
 * escolha explícita no canal vence; senão flag antigo `false` desliga; senão o preset decide.
 */
function billingEmailEnabled(prefs: Doc<"notificationPreferences"> | null, org: Doc<"organizations">): boolean {
  return channelAllows(BILLING_NOTICES_FLAG, "email", prefs as PolicyPrefs | null, orgDefaultsOf(org));
}

/**
 * Grava `channels.email.billingNotices = enabled` (merge com o `channels` existente). Idempotente:
 * se a escolha explícita já é essa, não escreve nem audita (decisão: o audit registra MUDANÇA,
 * e repetir o clique ou o POST de um scanner não infla o log).
 */
async function applyUnsubscribe(ctx: MutationCtx, target: Target, enabled: boolean): Promise<UnsubResult> {
  const { org, member } = target;
  const existing = await loadMemberPrefs(ctx, org._id, member._id);
  if (existing?.channels?.email?.[BILLING_NOTICES_FLAG] !== enabled) {
    const now = Date.now();
    const channels = {
      ...(existing?.channels ?? {}),
      email: { ...(existing?.channels?.email ?? {}), [BILLING_NOTICES_FLAG]: enabled },
    };
    await patchMemberPrefs(ctx, org._id, member._id, { channels }, now);
    // Ator = o próprio membro (dono do link). Sem e-mail, sem token, sem IP.
    await ctx.db.insert("auditLogs", {
      organizationId: org._id,
      entityType: "teamMember",
      entityId: member._id,
      action: "update",
      actorId: member._id,
      actorType: "human",
      metadata: { kind: "billing_unsub", on: enabled },
      description: enabled
        ? "E-mails de cobrança reativados pelo link do e-mail"
        : "E-mails de cobrança desativados pelo link do e-mail",
      severity: "low",
      createdAt: now,
    });
  }
  const after = await loadMemberPrefs(ctx, org._id, member._id);
  return { valid: true, orgName: org.name, enabled: billingEmailEnabled(after, org) };
}

/** Estado do link para a página `/notificacoes/desativar` (não altera nada). */
export const previewUnsubscribe = query({
  args: { token: v.string() },
  returns: unsubResultValidator,
  handler: async (ctx, args): Promise<UnsubResult> => {
    const target = await resolveTarget(ctx, args.token);
    if (!target) return invalid();
    const prefs = await loadMemberPrefs(ctx, target.org._id, target.member._id);
    return { valid: true, orgName: target.org.name, enabled: billingEmailEnabled(prefs, target.org) };
  },
});

/** Desativa (`enabled:false`) ou reativa (`enabled:true`) por clique na página. Sempre "set". */
export const setUnsubscribe = mutation({
  args: { token: v.string(), enabled: v.boolean() },
  returns: unsubResultValidator,
  handler: async (ctx, args): Promise<UnsubResult> => {
    const target = await resolveTarget(ctx, args.token);
    if (!target) return invalid();
    return await applyUnsubscribe(ctx, target, args.enabled);
  },
});

/**
 * POST one-click: conta no teto por IP (todo pedido conta, válido ou não; estourado não
 * incrementa nem toca prefs), depois verifica o token e desativa.
 */
export const internalOneClickUnsubscribe = internalMutation({
  args: { token: v.string(), throttleKey: v.string() },
  returns: v.union(v.literal("ok"), v.literal("invalid"), v.literal("rate_limited")),
  handler: async (ctx, args): Promise<"ok" | "invalid" | "rate_limited"> => {
    // A chave só pode ser do espaço `unsub ip:` (não colide com reset de senha nem verify-*).
    if (!THROTTLE_KEY_RE.test(args.throttleKey)) return "invalid";
    const now = Date.now();
    const row = await ctx.db
      .query("authEmailThrottle")
      .withIndex("by_email", (q) => q.eq("email", args.throttleKey))
      .first();
    const decision = evaluateFixedWindow(
      row ? { windowStart: row.windowStart, count: row.count } : null,
      now,
      { windowMs: UNSUB_IP_WINDOW_MS, limit: UNSUB_IP_LIMIT_PER_HOUR },
    );
    if (!decision.allowed) return "rate_limited";
    if (row) await ctx.db.patch(row._id, decision.next);
    else await ctx.db.insert("authEmailThrottle", { email: args.throttleKey, ...decision.next });

    const target = await resolveTarget(ctx, args.token);
    if (!target) return "invalid";
    await applyUnsubscribe(ctx, target, false);
    return "ok";
  },
});

const UNSUB_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
} as const;

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { ...UNSUB_RESPONSE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** Token da query; acima do teto vira "" (inválido) para não carregar lixo grande adiante. */
function tokenFromRequest(request: Request): string {
  const raw = new URL(request.url).searchParams.get("t") ?? "";
  return raw.length <= UNSUB_TOKEN_MAX_LEN ? raw : "";
}

/**
 * `POST /notifications/unsubscribe?t=`: one-click do provedor de e-mail. O corpo
 * (`List-Unsubscribe=One-Click`) não é exigido nem lido; o token vem da query.
 * O IP vem de `clientIpKey` (mesma porta das outras rotas: `cf-connecting-ip`, `x-real-ip`,
 * entrada mais à DIREITA de `x-forwarded-for`, que o cliente não forja) e só o hash sai daqui.
 */
export const oneClickUnsubscribeHttp = httpAction(async (ctx, request) => {
  const token = tokenFromRequest(request);
  const throttleKey = await unsubIpThrottleKey(clientIpKey(request), unsubSecretsFromEnv().current);
  let outcome: "ok" | "invalid" | "rate_limited";
  try {
    outcome = await ctx.runMutation(internal.billingUnsub.internalOneClickUnsubscribe, { token, throttleKey });
  } catch {
    return textResponse(500, "Erro. Tente de novo mais tarde.");
  }
  if (outcome === "rate_limited") return textResponse(429, "Muitas tentativas. Tente de novo mais tarde.");
  if (outcome === "invalid") return textResponse(400, "Link inválido.");
  return textResponse(200, "Pronto. Os e-mails de cobrança foram desativados.");
});

/**
 * `GET /notifications/unsubscribe?t=`: só redireciona para a página do app (scanners de e-mail
 * fazem GET; GET nunca altera estado nem lê o banco). O destino é sempre `appUrl()`.
 */
export const unsubscribeRedirectHttp = httpAction(async (_ctx, request) => {
  return new Response(null, {
    status: 302,
    headers: { ...UNSUB_RESPONSE_HEADERS, Location: unsubPageUrl(tokenFromRequest(request)) },
  });
});
