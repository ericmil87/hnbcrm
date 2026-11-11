/**
 * Onboarding conversacional v2 (P2.1): sessão por org + Rascunho de Operação.
 *
 * - Gravar o rascunho (`saveDraft`, `internalSaveDraft`) só VALIDA, normaliza,
 *   passa o filtro anti-instrução e grava. Nunca aplica configuração.
 * - A única escrita de configuração é `applyOnboardingDraft` (clique do
 *   usuário) → `lib/onboardingApply.ts`, pelas portas existentes.
 * - Tudo exige `settings:manage` na org do chamador; sessão de outra org é
 *   recusada como "não encontrada".
 */
import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, internalQuery, mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  getActiveMembership,
  isMembershipRevoked,
  requireAccountWithEmail,
  requirePermission,
} from "./lib/auth";
import { hasPermission, resolvePermissions, type Permissions, type Role } from "./lib/permissions";
import { assertValidDraft, draftHash, onboardingDraftValidator, type OnboardingDraft } from "./lib/onboardingDraft";
import { scanDraft, type DraftSourceText } from "./lib/onboardingDraftFilter";
import { applyOnboardingDraftCore, type ApplyResult } from "./lib/onboardingApply";
import { buildAuditDescription } from "./lib/auditDescription";

const SUMMARY_MAX = 2000;
const SOURCE_TEXTS_MAX = 20;
const SOURCE_TEXT_MAX = 50_000;

const stageValidator = v.union(
  v.literal("interview"),
  v.literal("materials"),
  v.literal("draft"),
  v.literal("applied"),
  v.literal("test"),
  v.literal("next_steps"),
);

const sessionValidator = v.object({
  _id: v.id("onboardingSessions"),
  organizationId: v.id("organizations"),
  stage: stageValidator,
  draft: v.union(onboardingDraftValidator, v.null()),
  draftHash: v.union(v.string(), v.null()),
  draftVersion: v.number(),
  summary: v.union(v.string(), v.null()),
  messageCount: v.number(),
  spentUsdMicros: v.number(),
  appliedAt: v.union(v.number(), v.null()),
  appliedDraftHash: v.union(v.string(), v.null()),
  /** Há rascunho gravado diferente do último aplicado. */
  hasUnappliedChanges: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const saveResultValidator = v.object({
  draftHash: v.string(),
  draftVersion: v.number(),
  /** Itens marcados pelo filtro anti-instrução (não entram na aplicação). */
  flagged: v.number(),
});

const featureOutcomeValidator = v.union(
  v.literal("applied"),
  v.literal("already_on"),
  v.literal("pending_consent"),
  v.literal("no_channel"),
  v.literal("not_requested"),
);
const featureKeyValidator = v.union(
  v.literal("vision"),
  v.literal("transcription"),
  v.literal("dateTime"),
  v.literal("translation"),
  v.literal("voice"),
);

const applyResultValidator = v.object({
  alreadyApplied: v.boolean(),
  draftHash: v.string(),
  boardId: v.union(v.id("boards"), v.null()),
  funnelMode: v.union(v.literal("replaced"), v.literal("created"), v.null()),
  fieldsCreated: v.number(),
  fieldsUpdated: v.number(),
  quickRepliesCreated: v.number(),
  quickRepliesSkipped: v.number(),
  attendantId: v.union(v.id("teamMembers"), v.null()),
  attendantCreated: v.boolean(),
  attendantModeReset: v.boolean(),
  skippedSuspicious: v.object({
    knowledge: v.number(),
    quickReplies: v.number(),
    handoffRules: v.number(),
    greeting: v.boolean(),
    business: v.boolean(),
  }),
  aiActive: v.boolean(),
  features: v.object({
    vision: featureOutcomeValidator,
    transcription: featureOutcomeValidator,
    dateTime: featureOutcomeValidator,
    translation: featureOutcomeValidator,
    voice: featureOutcomeValidator,
  }),
  /** Recursos marcados que dependem do aceite de IA/LGPD (ainda não dado). */
  pendingConsent: v.array(featureKeyValidator),
});

function toView(s: Doc<"onboardingSessions">) {
  return {
    _id: s._id,
    organizationId: s.organizationId,
    stage: s.stage,
    draft: s.draft ?? null,
    draftHash: s.draftHash ?? null,
    draftVersion: s.draftVersion,
    summary: s.summary ?? null,
    messageCount: s.messageCount,
    spentUsdMicros: s.spentUsdMicros,
    appliedAt: s.appliedAt ?? null,
    appliedDraftHash: s.appliedDraftHash ?? null,
    hasUnappliedChanges: s.draftHash !== undefined && s.draftHash !== s.appliedDraftHash,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

async function latestSession(ctx: QueryCtx | MutationCtx, organizationId: Id<"organizations">) {
  return await ctx.db
    .query("onboardingSessions")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .order("desc")
    .first();
}

/** Sessão por id, SÓ se for da org informada (outra org = não encontrada). */
async function loadSessionOfOrg(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  sessionId: Id<"onboardingSessions">,
): Promise<Doc<"onboardingSessions">> {
  const session = await ctx.db.get(sessionId);
  if (!session || session.organizationId !== organizationId) {
    throw new ConvexError("Sessão de onboarding não encontrada");
  }
  return session;
}

/** Membro ativo, humano, com `settings:manage` e conta com e-mail (caminho interno). */
async function requireActorMember(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  actorMemberId: Id<"teamMembers">,
): Promise<Doc<"teamMembers">> {
  const member = await ctx.db.get(actorMemberId);
  if (!member || member.organizationId !== organizationId || isMembershipRevoked(member)) {
    throw new ConvexError("Membro não encontrado nesta organização");
  }
  if (member.type !== "human" || !member.userId) throw new ConvexError("Só uma pessoa da equipe pode fazer isso");
  const perms = resolvePermissions(member.role as Role, member.permissions as Permissions | undefined);
  if (!hasPermission(perms, "settings", "manage")) throw new Error("Permissão insuficiente");
  await requireAccountWithEmail(ctx, member.userId);
  return member;
}

async function writeDraft(
  ctx: MutationCtx,
  params: {
    session: Doc<"onboardingSessions">;
    draft: OnboardingDraft;
    by: "user" | "ai";
    sourceTexts?: DraftSourceText[];
    expectedVersion?: number;
    actorId?: Id<"teamMembers">;
  },
) {
  const { session } = params;
  if (params.expectedVersion !== undefined && params.expectedVersion !== session.draftVersion) {
    throw new ConvexError("O rascunho foi alterado em outro lugar. Recarregue e tente de novo.");
  }
  if ((params.sourceTexts?.length ?? 0) > SOURCE_TEXTS_MAX) {
    throw new ConvexError(`No máximo ${SOURCE_TEXTS_MAX} textos de origem por gravação`);
  }
  const sourceTexts = params.sourceTexts?.map((s) => ({
    reference: s.reference,
    text: s.text.slice(0, SOURCE_TEXT_MAX),
  }));
  const normalized = assertValidDraft(params.draft);
  // As marcas `suspicious` são SEMPRE recalculadas aqui (o valor de entrada é ignorado).
  const { draft, flagged } = scanDraft(normalized, { sourceTexts, previous: session.draft ?? null });
  const hash = await draftHash(draft);
  const now = Date.now();
  const nextStage =
    session.stage === "interview" || session.stage === "materials" || (session.stage === "applied" && hash !== session.appliedDraftHash)
      ? "draft"
      : session.stage;
  const draftVersion = session.draftVersion + 1;
  await ctx.db.patch(session._id, {
    draft,
    draftHash: hash,
    draftVersion,
    draftUpdatedBy: params.by,
    stage: nextStage,
    updatedAt: now,
  });
  return { draftHash: hash, draftVersion, flagged };
}

// ── API pública ─────────────────────────────────────────────────────────────

/** Sessão mais recente da org do chamador; cria uma se não houver. */
export const getOrCreateSession = mutation({
  args: { organizationId: v.id("organizations") },
  returns: sessionValidator,
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    await requireAccountWithEmail(ctx);
    const existing = await latestSession(ctx, args.organizationId);
    if (existing) return toView(existing);
    const now = Date.now();
    const id = await ctx.db.insert("onboardingSessions", {
      organizationId: args.organizationId,
      createdBy: member._id,
      stage: "interview",
      draftVersion: 0,
      messageCount: 0,
      spentUsdMicros: 0,
      createdAt: now,
      updatedAt: now,
    });
    const metadata = { action: "onboarding_session_created" };
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "onboardingSession",
      entityId: id,
      action: "create",
      actorId: member._id,
      actorType: "human",
      metadata,
      description: buildAuditDescription({ action: "create", entityType: "onboardingSession", metadata }),
      severity: "low",
      createdAt: now,
    });
    return toView((await ctx.db.get(id))!);
  },
});

/** Sessão mais recente da org (ou null). Não-membro recebe null; membro sem permissão, erro. */
export const getSession = query({
  args: { organizationId: v.id("organizations") },
  returns: v.union(sessionValidator, v.null()),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId || !(await getActiveMembership(ctx, args.organizationId, userId))) return null;
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    const session = await latestSession(ctx, args.organizationId);
    return session ? toView(session) : null;
  },
});

/**
 * Grava o rascunho editado pelo usuário ("Ajustar"). Só valida e grava; nunca
 * aplica. `expectedVersion` (opcional) recusa gravar sobre uma versão mais nova.
 */
export const saveDraft = mutation({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.id("onboardingSessions"),
    draft: onboardingDraftValidator,
    expectedVersion: v.optional(v.number()),
  },
  returns: saveResultValidator,
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    await requireAccountWithEmail(ctx);
    const session = await loadSessionOfOrg(ctx, args.organizationId, args.sessionId);
    return await writeDraft(ctx, {
      session,
      draft: args.draft,
      by: "user",
      expectedVersion: args.expectedVersion,
      actorId: member._id,
    });
  },
});

/** Clique "Montar minha operação": aplica o rascunho gravado numa transação. */
export const applyOnboardingDraft = mutation({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.id("onboardingSessions"),
    /** Hash do rascunho que a pessoa revisou; diferente do gravado = recusa. */
    expectedDraftHash: v.optional(v.string()),
  },
  returns: applyResultValidator,
  handler: async (ctx, args): Promise<ApplyResult> => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    await requireAccountWithEmail(ctx);
    return await applyAsMember(ctx, args.organizationId, args.sessionId, member, args.expectedDraftHash);
  },
});

async function applyAsMember(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  sessionId: Id<"onboardingSessions">,
  member: Doc<"teamMembers">,
  expectedDraftHash: string | undefined,
): Promise<ApplyResult> {
  const session = await loadSessionOfOrg(ctx, organizationId, sessionId);
  const org = await ctx.db.get(organizationId);
  if (!org) throw new ConvexError("Organização não encontrada");
  return await applyOnboardingDraftCore(ctx, { org, member, session, expectedDraftHash });
}

// ── API interna (pipeline de IA do P2.3 e testes) ───────────────────────────

/** Leitura da sessão para o pipeline (já resolvido o membro/org no chamador). */
export const internalGetSession = internalQuery({
  args: { organizationId: v.id("organizations"), sessionId: v.id("onboardingSessions") },
  returns: v.union(sessionValidator, v.null()),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.organizationId !== args.organizationId) return null;
    return toView(session);
  },
});

/**
 * Proposta do entrevistador/leitor (P2.3): mesma validação e filtro do
 * caminho do usuário; `sourceTexts` (texto extraído de site/PDF/áudio/imagem,
 * casado por `origin.reference`) permite reconhecer URL/telefone vistos na
 * fonte. Nunca aplica configuração.
 */
export const internalSaveDraft = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.id("onboardingSessions"),
    draft: onboardingDraftValidator,
    sourceTexts: v.optional(v.array(v.object({ reference: v.string(), text: v.string() }))),
    expectedVersion: v.optional(v.number()),
  },
  returns: saveResultValidator,
  handler: async (ctx, args) => {
    const session = await loadSessionOfOrg(ctx, args.organizationId, args.sessionId);
    return await writeDraft(ctx, {
      session,
      draft: args.draft,
      by: "ai",
      sourceTexts: args.sourceTexts,
      expectedVersion: args.expectedVersion,
    });
  },
});

/** Resumo curto da conversa e contagem de mensagens (P2.3). Texto cortado em 2.000. */
export const internalUpdateSummary = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.id("onboardingSessions"),
    summary: v.optional(v.string()),
    messageCountDelta: v.optional(v.number()),
    stage: v.optional(stageValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await loadSessionOfOrg(ctx, args.organizationId, args.sessionId);
    const delta = args.messageCountDelta ?? 0;
    if (!Number.isInteger(delta) || delta < 0 || delta > 100) {
      throw new ConvexError("messageCountDelta deve ser um inteiro de 0 a 100");
    }
    if (args.stage === "applied") throw new ConvexError("Só a aplicação marca a sessão como aplicada");
    await ctx.db.patch(session._id, {
      ...(args.summary !== undefined ? { summary: args.summary.trim().slice(0, SUMMARY_MAX) } : {}),
      messageCount: session.messageCount + delta,
      ...(args.stage ? { stage: args.stage } : {}),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Aplicação pelo caminho interno (mesmo core do clique). Exige um membro
 * humano ativo com `settings:manage` e conta com e-mail; não existe caminho
 * sem pessoa por trás.
 */
export const internalApplyOnboardingDraft = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.id("onboardingSessions"),
    actorMemberId: v.id("teamMembers"),
    expectedDraftHash: v.optional(v.string()),
  },
  returns: applyResultValidator,
  handler: async (ctx, args): Promise<ApplyResult> => {
    const member = await requireActorMember(ctx, args.organizationId, args.actorMemberId);
    return await applyAsMember(ctx, args.organizationId, args.sessionId, member, args.expectedDraftHash);
  },
});
