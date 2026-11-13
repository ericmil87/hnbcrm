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
import { ConvexError, v, type Infer } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, internalQuery, mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { getActiveMembership, isMembershipRevoked, requireAccountWithEmail, requirePermission } from "./lib/auth";
import { hasPermission, resolvePermissions, type Permissions, type Role } from "./lib/permissions";
import { resolveEntitlements } from "./lib/entitlements";
import { evaluateSpend, monthKeyUtc, resolveSpendCap } from "./lib/aiSpend";
import { deleteBlobIfUnreferenced } from "./lib/fileRefs";
import { deleteFileRow } from "./lib/storageUsage";
import {
  ARCHIVED_SESSION_MESSAGE,
  RESTART_LIMITS,
  RESTART_RATE_LIMIT_MESSAGE,
  entryConversationState,
  entryOrgConfigured,
  evaluateRestartRate,
  newOrgTrialFor,
  restartCarryOver,
  sessionHasProgress,
} from "./lib/onboardingRestart";
import { assertValidDraft, draftHash, onboardingDraftValidator, type OnboardingDraft } from "./lib/onboardingDraft";
import { scanDraft, type DraftSourceText } from "./lib/onboardingDraftFilter";
import { applyOnboardingDraftCore, type ApplyResult } from "./lib/onboardingApply";
import { buildAuditDescription } from "./lib/auditDescription";
import { APPROVAL_SECTIONS, ROADMAP_STEPS, sectionSignature, type ApprovalSection } from "./lib/onboardingRoadmap";

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
  /** Assinatura aprovada por seção ("Está bom, seguir"); mudou o conteúdo = pendente de novo. */
  approvals: v.object({
    funnel: v.optional(v.string()),
    persona: v.optional(v.string()),
    knowledge: v.optional(v.string()),
  }),
  /** Etapa (0-based) mais avançada já alcançada: a barra nunca regride. */
  reachedStep: v.number(),
  /** A pessoa testou a IA. */
  tested: v.boolean(),
  /** Canal conectado ou "conectar depois" escolhido. */
  connected: v.boolean(),
  /** Links guardados à espera da confirmação do e-mail. */
  pendingMaterialsCount: v.number(),
  /** A operação já foi montada por uma conversa anterior (recomeçada); o CRM continua com ela. */
  priorApplied: v.boolean(),
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
    approvals: s.approvals ?? {},
    reachedStep: s.reachedStep ?? 0,
    tested: s.testedAt !== undefined,
    connected: s.channelStepAt !== undefined,
    pendingMaterialsCount: s.pendingMaterials?.length ?? 0,
    priorApplied: s.priorAppliedAt !== undefined,
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

/** Como `loadSessionOfOrg`, mas recusa sessão ARQUIVADA (conversa recomeçada em outra aba). */
async function loadActiveSessionOfOrg(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  sessionId: Id<"onboardingSessions">,
): Promise<Doc<"onboardingSessions">> {
  const session = await loadSessionOfOrg(ctx, organizationId, sessionId);
  if (session.archivedAt !== undefined) throw new ConvexError(ARCHIVED_SESSION_MESSAGE);
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

/**
 * Sessão mais recente da org; cria (com audit `low`) se não houver. O CHAMADOR
 * já resolveu `settings:manage` + conta com e-mail (também usada pelo turno do
 * onboarding por conversa, `onboardingChat.internalPrepareTurn`).
 */
export async function ensureOnboardingSession(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  member: Doc<"teamMembers">,
): Promise<Doc<"onboardingSessions">> {
  const existing = await latestSession(ctx, organizationId);
  // A mais recente nunca fica arquivada (o recomeço cria a nova na mesma transação); por garantia, cria outra.
  if (existing && existing.archivedAt === undefined) return existing;
  const now = Date.now();
  const id = await ctx.db.insert("onboardingSessions", {
    organizationId,
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
    organizationId,
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
  return (await ctx.db.get(id))!;
}

// ── API pública ─────────────────────────────────────────────────────────────

/** Sessão mais recente da org do chamador; cria uma se não houver. */
export const getOrCreateSession = mutation({
  args: { organizationId: v.id("organizations") },
  returns: sessionValidator,
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    await requireAccountWithEmail(ctx);
    return toView(await ensureOnboardingSession(ctx, args.organizationId, member));
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
    const session = await loadActiveSessionOfOrg(ctx, args.organizationId, args.sessionId);
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
    const session = await loadActiveSessionOfOrg(ctx, args.organizationId, args.sessionId);
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new ConvexError("Organização não encontrada");
    const result = await applyOnboardingDraftCore(ctx, {
      org,
      member,
      session,
      expectedDraftHash: args.expectedDraftHash,
      overwriteExistingAttendant: args.overwriteExistingAttendant === true,
    });
    // Resumo (segmento, plano de interesse) no lead de cadastro da org interna. Só ids.
    // Sem a env da org interna não há para quem resumir: nem agenda o job.
    if (!result.alreadyApplied && process.env.HNBCRM_INTERNAL_ORG_ID) {
      await ctx.scheduler.runAfter(0, internal.hnbcrmLeads.internalApplySignupSummary, {
        organizationId: args.organizationId,
        sessionId: args.sessionId,
      });
    }
    return result;
  },
});

// ── Recomeçar a conversa ────────────────────────────────────────────────────

const PURGE_BATCH = 100;

/**
 * "Recomeçar a conversa": ARQUIVA a sessão atual (mensagens, cartões,
 * aprovações, progresso, rascunho e links pendentes saem da vista) e abre uma
 * nova, que volta à saudação. Nada do CRM é tocado (funil, atendente, respostas
 * rápidas, canal, aceite de IA, e-mail confirmado); a nova sessão herda o gasto
 * da antiga (o orçamento não zera) e a ciência do aviso (`restartCarryOver`).
 * Idempotente: sessão já arquivada ou que deixou de ser a atual devolve a
 * atual sem criar outra; sessão vazia não é arquivada. No máximo 3 recomeços
 * por hora e 10 por dia por organização. Os arquivos da conversa antiga
 * (anexos e respostas em áudio) são apagados em lotes por
 * `internalPurgeArchivedSessionFiles`, pela porta de arquivos.
 */
export const restartConversation = mutation({
  args: { organizationId: v.id("organizations"), sessionId: v.id("onboardingSessions") },
  returns: v.object({ sessionId: v.id("onboardingSessions"), restarted: v.boolean() }),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    await requireAccountWithEmail(ctx);
    const target = await loadSessionOfOrg(ctx, args.organizationId, args.sessionId);
    const latest = await latestSession(ctx, args.organizationId);
    if (target.archivedAt !== undefined || (latest !== null && latest._id !== target._id)) {
      // Clique duplo ou outra aba: a conversa já recomeçou.
      const current = await ensureOnboardingSession(ctx, args.organizationId, member);
      return { sessionId: current._id, restarted: false };
    }
    const anyMessage = await ctx.db
      .query("onboardingMessages")
      .withIndex("by_session", (q) => q.eq("sessionId", target._id))
      .first();
    if (!sessionHasProgress(target, anyMessage !== null)) {
      return { sessionId: target._id, restarted: false };
    }

    const now = Date.now();
    // Só o recomeço cria sessão nova depois da primeira: as 12 mais recentes cobrem a janela do dia.
    const recent = await ctx.db
      .query("onboardingSessions")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .take(RESTART_LIMITS.perDay + 2);
    const rate = evaluateRestartRate(
      recent.flatMap((s) => (s.archivedAt !== undefined ? [s.archivedAt] : [])),
      now,
    );
    if (!rate.allowed) {
      const minutes = Math.max(1, Math.ceil(rate.retryAfterMs / 60_000));
      throw new ConvexError(`${RESTART_RATE_LIMIT_MESSAGE} Tente de novo em ${minutes} ${minutes === 1 ? "minuto" : "minutos"}.`);
    }

    await ctx.db.patch(target._id, { archivedAt: now, archivedBy: member._id, updatedAt: now });
    const newId = await ctx.db.insert("onboardingSessions", {
      organizationId: args.organizationId,
      createdBy: member._id,
      stage: "interview",
      draftVersion: 0,
      messageCount: 0,
      ...restartCarryOver(target),
      createdAt: now,
      updatedAt: now,
    });
    const metadata = {
      action: "onboarding_conversation_restarted",
      previousSessionId: target._id,
      newSessionId: newId,
      messageCount: target.messageCount,
      hadApplied: target.appliedAt !== undefined || target.priorAppliedAt !== undefined,
    };
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "onboardingSession",
      entityId: target._id,
      action: "update",
      actorId: member._id,
      actorType: "human",
      metadata,
      description:
        "Recomeçou a conversa de configuração (a conversa anterior foi arquivada; nada do CRM foi alterado)",
      severity: "medium",
      createdAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.onboardingSessions.internalPurgeArchivedSessionFiles, {
      organizationId: args.organizationId,
      sessionId: target._id,
      cursor: null,
    });
    return { sessionId: newId, restarted: true };
  },
});

/**
 * Apaga os arquivos de uma sessão ARQUIVADA, em lotes de 100 mensagens
 * (reagenda pelo cursor): respostas em áudio (linha de `files` da org com
 * `metadata.kind:"onboarding_voice_reply"`) e anexos enviados na conversa
 * (`message_attachment` da org sem vínculo com mensagem/contato/lead/membro,
 * que é como o upload do onboarding nasce). Blob só sai se nenhuma outra linha
 * o referencia (`lib/fileRefs.ts`); a linha sai por `deleteFileRow` (cota). O
 * texto das mensagens fica (histórico arquivado, some na purga da org).
 */
export const internalPurgeArchivedSessionFiles = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.id("onboardingSessions"),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({ processed: v.number(), filesDeleted: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.organizationId !== args.organizationId || session.archivedAt === undefined) {
      return { processed: 0, filesDeleted: 0, done: true };
    }
    const page = await ctx.db
      .query("onboardingMessages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .paginate({ numItems: PURGE_BATCH, cursor: args.cursor });
    let filesDeleted = 0;
    for (const m of page.page) {
      if (m.audio) {
        const file = await ctx.db.get(m.audio.fileId);
        if (file && file.organizationId === m.organizationId && file.metadata?.kind === "onboarding_voice_reply") {
          await deleteBlobIfUnreferenced(ctx, file);
          await deleteFileRow(ctx, file);
          filesDeleted++;
        }
        await ctx.db.patch(m._id, { audio: undefined, audioExpiresAt: undefined });
      }
      const storageId = m.attachment?.storageId;
      if (m.attachment && storageId) {
        const rows = await ctx.db
          .query("files")
          .withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
          .take(5);
        for (const row of rows) {
          const uploadOnly =
            row.organizationId === m.organizationId &&
            row.fileType === "message_attachment" &&
            row.messageId === undefined &&
            row.contactId === undefined &&
            row.leadId === undefined &&
            row.teamMemberId === undefined;
          if (!uploadOnly) continue;
          await deleteBlobIfUnreferenced(ctx, row);
          await deleteFileRow(ctx, row);
          filesDeleted++;
        }
        await ctx.db.patch(m._id, { attachment: { kind: m.attachment.kind, label: m.attachment.label } });
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.onboardingSessions.internalPurgeArchivedSessionFiles, {
        organizationId: args.organizationId,
        sessionId: args.sessionId,
        cursor: page.continueCursor,
      });
    }
    return { processed: page.page.length, filesDeleted, done: page.isDone };
  },
});

// ── Entrada de quem já tem empresa (`/comecar`) ─────────────────────────────

const ENTRY_ORGS_MAX = 50;
const ENTRY_DETAILED_MAX = 20;

const entryOrgValidator = v.object({
  organizationId: v.id("organizations"),
  name: v.string(),
  /** Pode configurar (`settings:manage`). Sem ela, os demais campos vêm neutros. */
  canManage: v.boolean(),
  /** Já existe operação de verdade (conversa aplicada, assistente concluído, atendente, WhatsApp ou leads). */
  configured: v.boolean(),
  conversation: v.union(v.literal("none"), v.literal("in_progress"), v.literal("applied")),
  /** Etapa (0-based) mais avançada da conversa atual. */
  reachedStep: v.number(),
  /** IA pausada pelo plano (modo leitura / teste vencido). */
  readOnly: v.boolean(),
  /** Teto de gastos de IA da org atingido no mês. */
  spendCapReached: v.boolean(),
});

/**
 * Resumo para a tela de entrada de `/comecar`: as organizações do usuário (só
 * as dele, membro ativo) com o que a tela precisa para escolher o destino sem
 * mexer em nada, e o que acontece com o teste grátis numa empresa nova.
 * `now` vem do cliente (query não lê o relógio); serve só para o modo leitura,
 * o teto do mês e o teste. Sem login = null.
 */
export const getEntryOverview = query({
  args: { now: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      orgs: v.array(entryOrgValidator),
      newOrgTrial: v.union(v.literal("none"), v.literal("fresh"), v.literal("shared_active"), v.literal("shared_expired")),
      newOrgTrialEndsAt: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    if (!Number.isFinite(args.now) || args.now <= 0) throw new ConvexError("Data inválida");
    const now = args.now;

    const memberships = await ctx.db
      .query("teamMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(ENTRY_ORGS_MAX);
    const seen = new Set<string>();
    const orgs: Array<Infer<typeof entryOrgValidator>> = [];
    let detailed = 0;
    for (const member of memberships) {
      if (isMembershipRevoked(member) || seen.has(member.organizationId)) continue;
      seen.add(member.organizationId);
      const org = await ctx.db.get(member.organizationId);
      if (!org) continue;
      const perms = resolvePermissions(member.role as Role, (member as { permissions?: Permissions }).permissions);
      const canManage = hasPermission(perms, "settings", "manage");
      const neutral = {
        organizationId: org._id,
        name: org.name,
        canManage,
        configured: false,
        conversation: "none" as const,
        reachedStep: 0,
        readOnly: false,
        spendCapReached: false,
      };
      if (!canManage || detailed >= ENTRY_DETAILED_MAX) {
        orgs.push(neutral);
        continue;
      }
      detailed++;
      const session = await latestSession(ctx, org._id);
      const conversation = entryConversationState(session);
      const aiMembers = await ctx.db
        .query("teamMembers")
        .withIndex("by_organization_and_type", (q) => q.eq("organizationId", org._id).eq("type", "ai"))
        .take(50);
      const hasAttendant = aiMembers.some(
        (m) => m.agentProfile?.kind === "attendant" && !isMembershipRevoked(m),
      );
      const channels = await ctx.db
        .query("channelConfigs")
        .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
        .take(100);
      const whatsappConnected = channels.some(
        (c) => c.channel === "whatsapp" && (c.provider === "bridge" ? c.bridgeSessionState === "connected" : c.status === "active"),
      );
      const anyLead = await ctx.db
        .query("leads")
        .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
        .first();
      const usage = await ctx.db
        .query("aiUsageMonthly")
        .withIndex("by_organization_and_month", (q) => q.eq("organizationId", org._id).eq("month", monthKeyUtc(now)))
        .unique();
      orgs.push({
        ...neutral,
        configured: entryOrgConfigured({
          conversation,
          wizardCompleted: !!org.onboardingMeta?.wizardCompletedAt,
          hasAttendant,
          whatsappConnected,
          hasLeads: anyLead !== null,
        }),
        conversation,
        reachedStep: session && session.archivedAt === undefined ? (session.reachedStep ?? 0) : 0,
        readOnly: !resolveEntitlements(org, now).aiAllowed,
        spendCapReached: evaluateSpend(usage?.costUsdMicros ?? 0, resolveSpendCap(org.settings.aiConfig?.spendCap)).blocked,
      });
    }

    const firstGrant = await ctx.db
      .query("trialGrants")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    const newOrgTrial = newOrgTrialFor(process.env.BILLING_TRIAL_ON_SIGNUP === "true", firstGrant?.endsAt ?? null, now);
    return {
      orgs,
      newOrgTrial,
      newOrgTrialEndsAt: newOrgTrial === "shared_active" || newOrgTrial === "shared_expired" ? (firstGrant?.endsAt ?? null) : null,
    };
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
 * caminho da pessoa, com três diferenças: em item NOVO ou ALTERADO nesta
 * gravação a origem "usuario"/"template" é rebaixada para externa e a
 * liberação é zerada (item idêntico ao anterior — mesmo texto e mesma
 * origem — mantém origem, marca, `verifiedInSource` e liberação), e `sourceTexts` (texto
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
    const session = await loadActiveSessionOfOrg(ctx, args.organizationId, args.sessionId);
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
    /** Última assinatura mostrada por tipo de cartão (mescla com a gravada). */
    shownCards: v.optional(v.record(v.string(), v.string())),
    /** Etapa mais avançada alcançada (0–5): só sobe. */
    reachedStep: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await loadActiveSessionOfOrg(ctx, args.organizationId, args.sessionId);
    const delta = args.messageCountDelta ?? 0;
    if (!Number.isInteger(delta) || delta < 0 || delta > 100) {
      throw new ConvexError("messageCountDelta deve ser um inteiro de 0 a 100");
    }
    if (args.stage === "applied") throw new ConvexError("Só a aplicação marca a sessão como aplicada");
    await ctx.db.patch(session._id, {
      ...(args.summary !== undefined ? { summary: args.summary.trim().slice(0, SUMMARY_MAX) } : {}),
      messageCount: session.messageCount + delta,
      ...(args.stage ? { stage: args.stage } : {}),
      ...(args.shownCards ? { shownCards: { ...(session.shownCards ?? {}), ...args.shownCards } } : {}),
      ...(args.reachedStep !== undefined && Number.isInteger(args.reachedStep)
        ? { reachedStep: Math.max(session.reachedStep ?? 0, Math.min(ROADMAP_STEPS.length - 1, Math.max(0, args.reachedStep))) }
        : {}),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * "Está bom, seguir" de uma seção do rascunho (evento `approve` do roteiro).
 * Grava a assinatura ATUAL do conteúdo (`sectionSignature`); se a tela mandou
 * `sig` e ela difere da atual, NÃO aprova (`stale`: o cartão mudou). Audit `low`
 * sem texto livre. Idempotente (aprovar de novo a mesma assinatura não grava).
 */
export const internalApproveSection = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.id("onboardingSessions"),
    memberId: v.id("teamMembers"),
    section: v.union(v.literal("funnel"), v.literal("persona"), v.literal("knowledge")),
    sig: v.optional(v.string()),
  },
  returns: v.object({ status: v.union(v.literal("approved"), v.literal("unchanged"), v.literal("stale"), v.literal("no_draft")) }),
  handler: async (ctx, args) => {
    if (!(APPROVAL_SECTIONS as readonly string[]).includes(args.section)) throw new ConvexError("Seção inválida");
    const session = await loadActiveSessionOfOrg(ctx, args.organizationId, args.sessionId);
    if (!session.draft) return { status: "no_draft" as const };
    const section = args.section as ApprovalSection;
    const current = sectionSignature(session.draft, section);
    if (args.sig !== undefined && args.sig !== current) return { status: "stale" as const };
    if (session.approvals?.[section] === current) return { status: "unchanged" as const };
    const now = Date.now();
    await ctx.db.patch(session._id, { approvals: { ...(session.approvals ?? {}), [section]: current }, updatedAt: now });
    const metadata = { action: "onboarding_section_approved", section };
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "onboardingSession",
      entityId: session._id,
      action: "update",
      actorId: args.memberId,
      actorType: "human",
      metadata,
      description: buildAuditDescription({ action: "update", entityType: "onboardingSession", metadata }),
      severity: "low",
      createdAt: now,
    });
    return { status: "approved" as const };
  },
});
