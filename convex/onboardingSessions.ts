/**
 * Onboarding conversacional v2 (P2.1): sessão por org + Rascunho de Operação.
 *
 * - Gravar o rascunho (`saveDraft` pela pessoa, `internalSaveDraft` pelo
 *   pipeline de IA) só VALIDA, normaliza, passa o filtro anti-instrução e
 *   grava. Nunca aplica configuração.
 * - A ÚNICA escrita de configuração é a mutation pública
 *   `applyOnboardingDraft` (clique do usuário) → `lib/onboardingApply.ts`,
 *   pelas portas existentes. Não existe caminho interno de aplicação.
 * - Tudo exige `settings:manage` + conta com e-mail na org do chamador;
 *   sessão de outra org é recusada como "não encontrada".
 */
import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, internalQuery, mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getActiveMembership, requireAccountWithEmail, requirePermission } from "./lib/auth";
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
  /** Itens marcados pelo filtro anti-instrução (só entram se liberados por uma pessoa). */
  flagged: v.number(),
  /** Textos estruturais marcados (etapas, campos, nome): bloqueiam a aplicação até serem editados. */
  blocked: v.number(),
  /** Liberações novas registradas nesta gravação (só `saveDraft`). */
  released: v.number(),
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
  attendant: v.union(
    v.literal("created"),
    v.literal("updated"),
    v.literal("overwritten"),
    v.literal("skipped_existing"),
    v.literal("pending_consent"),
    v.literal("unchanged"),
  ),
  attendantId: v.union(v.id("teamMembers"), v.null()),
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

async function writeDraft(
  ctx: MutationCtx,
  params: {
    session: Doc<"onboardingSessions">;
    draft: OnboardingDraft;
    by: "user" | "ai";
    expectedVersion: number;
    sourceTexts?: DraftSourceText[];
    actor?: Doc<"teamMembers">;
  },
) {
  const { session } = params;
  if (params.expectedVersion !== session.draftVersion) {
    throw new ConvexError("O rascunho foi alterado em outro lugar. Recarregue e tente de novo.");
  }
  if ((params.sourceTexts?.length ?? 0) > SOURCE_TEXTS_MAX) {
    throw new ConvexError(`No máximo ${SOURCE_TEXTS_MAX} textos de origem por gravação`);
  }
  const sourceTexts = params.sourceTexts?.map((s) => ({
    reference: s.reference,
    text: s.text.slice(0, SOURCE_TEXT_MAX),
  }));
  const now = Date.now();
  const normalized = assertValidDraft(params.draft);
  // Marcas, verificação na fonte, liberações e bloqueios são SEMPRE
  // recalculados aqui; o valor de entrada não vale.
  const scanned = scanDraft(normalized, {
    mode: params.by,
    sourceTexts,
    previous: session.draft ?? null,
    actorId: params.actor?._id,
    now,
  });
  // Renormaliza o resultado do filtro: o que é gravado é o que o hash cobre.
  const draft = assertValidDraft(scanned.draft);
  const hash = await draftHash(draft);
  const nextStage =
    session.stage === "interview" ||
    session.stage === "materials" ||
    (session.stage === "applied" && hash !== session.appliedDraftHash)
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

  const actorFields = params.actor
    ? { actorId: params.actor._id, actorType: "human" as const }
    : { actorType: "system" as const };
  const metadata = {
    action: "onboarding_draft_saved",
    by: params.by,
    draftVersion,
    draftHash: hash.slice(0, 16),
    flagged: scanned.flagged,
    blocked: scanned.blocked,
  };
  await ctx.db.insert("auditLogs", {
    organizationId: session.organizationId,
    entityType: "onboardingSession",
    entityId: session._id,
    action: "update",
    ...actorFields,
    metadata,
    description: buildAuditDescription({ action: "update", entityType: "onboardingSession", metadata }),
    severity: "low",
    createdAt: now,
  });
  // Liberação humana de item marcado: aviso aceito explicitamente, auditado
  // com o motivo (o texto do item fica fora do log).
  if (scanned.releases.length > 0) {
    await ctx.db.insert("auditLogs", {
      organizationId: session.organizationId,
      entityType: "onboardingSession",
      entityId: session._id,
      action: "update",
      ...actorFields,
      metadata: {
        action: "onboarding_items_released",
        draftVersion,
        releases: scanned.releases.map((r) => ({
          field: r.field,
          reason: r.reason,
          ...(r.suspicionReason ? { suspicionReason: r.suspicionReason } : {}),
        })),
      },
      description: `Liberou ${scanned.releases.length} item(ns) marcado(s) pelo filtro do onboarding para entrar na operação`,
      severity: "high",
      createdAt: now,
    });
  }
  return { draftHash: hash, draftVersion, flagged: scanned.flagged, blocked: scanned.blocked, released: scanned.releases.length };
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
 * Grava o rascunho editado pela pessoa ("Ajustar" / "Liberar mesmo assim").
 * Só valida e grava; nunca aplica. `expectedVersion` = `draftVersion` que a
 * tela tinha (recusa gravar sobre uma versão mais nova).
 */
export const saveDraft = mutation({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.id("onboardingSessions"),
    draft: onboardingDraftValidator,
    expectedVersion: v.number(),
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
      actor: member,
    });
  },
});

/** Clique "Montar minha operação": aplica o rascunho gravado numa transação. */
export const applyOnboardingDraft = mutation({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.id("onboardingSessions"),
    /** Hash do rascunho que a pessoa revisou; diferente do gravado = recusa. */
    expectedDraftHash: v.string(),
    /**
     * A org já tinha atendente (não criado por esta sessão): só sobrescreve a
     * persona/conhecimento dele com este `true` explícito (audit `high` com o
     * texto anterior). Ausente = mantém o atendente e devolve `skipped_existing`.
     */
    overwriteExistingAttendant: v.optional(v.boolean()),
  },
  returns: applyResultValidator,
  handler: async (ctx, args): Promise<ApplyResult> => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    await requireAccountWithEmail(ctx);
    const session = await loadSessionOfOrg(ctx, args.organizationId, args.sessionId);
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new ConvexError("Organização não encontrada");
    return await applyOnboardingDraftCore(ctx, {
      org,
      member,
      session,
      expectedDraftHash: args.expectedDraftHash,
      overwriteExistingAttendant: args.overwriteExistingAttendant === true,
    });
  },
});

// ── API interna (pipeline de IA do P2.3) — nunca aplica ─────────────────────

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
 * caminho da pessoa, com três diferenças: a origem "usuario"/"template" é
 * rebaixada para externa, liberações são zeradas e `sourceTexts` (texto
 * extraído de site/PDF/áudio/imagem, casado por `origin.reference`) permite
 * reconhecer link/telefone vistos na fonte (`verifiedInSource`).
 */
export const internalSaveDraft = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.id("onboardingSessions"),
    draft: onboardingDraftValidator,
    expectedVersion: v.number(),
    sourceTexts: v.optional(v.array(v.object({ reference: v.string(), text: v.string() }))),
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
