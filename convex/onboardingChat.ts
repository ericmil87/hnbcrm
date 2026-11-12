/**
 * Onboarding conversacional v2 (P2.3): histórico da conversa e o turno do
 * LEITOR em quarentena + ENTREVISTADOR (o loop mora em `lib/onboardingTurn.ts`).
 *
 * Gates (todas as entradas): conta autenticada com e-mail + `settings:manage`
 * na org (D1: nenhum LLM antes da conta). Materiais (URL, PDF, imagem, áudio)
 * exigem e-mail CONFIRMADO (D2, `isEmailVerifiedForMaterials` em `lib/emailVerification.ts`, preenchido pelo fluxo de código do P2.6). A IA só
 * escreve o rascunho (`onboardingSessions.internalSaveDraft`); configuração
 * só pelo clique `applyOnboardingDraft`.
 *
 * Porta do frontend: SSE `POST /api/onboarding/stream` (`onboardingHttp.ts`,
 * rota em `router.ts`). `internalSendTurn` roda o MESMO loop sem stream, só
 * para testes/ops (não é público: o limite por IP vive na rota HTTP).
 *
 * Aviso de materiais: o 1º material de uma sessão exige a ciência explícita
 * (`ackMaterialsNotice`, clique; audit `medium`); sem ela, `notice_required`.
 */
import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalAction, internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getActiveMembership, requireAccountWithEmail, requirePermission } from "./lib/auth";
import { resolvePermissions, type Permissions, type Role } from "./lib/permissions";
import { orgAiActive } from "./lib/agentSecurity";
import { isEmailVerifiedForMaterials } from "./lib/emailVerification";
import { maskEmailForDisplay } from "./lib/emailAddress";
import { requestEmailVerificationCodeCore } from "./emailVerification";
import { coherentChips, type RoadmapFacts } from "./lib/onboardingRoadmap";
import { ensureOnboardingSession } from "./onboardingSessions";
import { onboardingBlockValidator } from "./lib/onboardingBlocks";
import { onboardingDraftValidator } from "./lib/onboardingDraft";
import { siteKeyOf, MAX_PAGES_PER_SITE } from "./lib/htmlExtract";
import { HISTORY_FOR_PROMPT, USER_TEXT_MAX, REPLY_MAX } from "./lib/onboardingInterviewer";
import { buildAuditDescription } from "./lib/auditDescription";
import { runOnboardingTurn, turnInputValidator, turnResultValidator, type TurnResult } from "./lib/onboardingTurn";
import { ONBOARDING_AUDIO_MAX_BYTES, ONBOARDING_IMAGE_MAX_BYTES, ONBOARDING_PDF_MAX_BYTES } from "./lib/onboardingLimits";
import { cronsDisabled } from "./lib/cronGuard";
import { deleteBlobIfUnreferenced } from "./lib/fileRefs";
import { deleteFileRow } from "./lib/storageUsage";

/** Teto por mensagem gravada (usuário até 4.000; assistente até 800 + folga). */
const MESSAGE_TEXT_MAX = USER_TEXT_MAX;
const CHIPS_STORED_MAX = 6;
const ATTACHMENT_LABEL_MAX = 200;
/**
 * Áudio do usuário: ~2 MB (≈ 3 min de voz em opus/webm). O navegador não
 * manda duração confiável; o teto em bytes protege o Whisper, que é o MESMO
 * serviço da transcrição dos clientes reais.
 */
const AUDIO_MAX_BYTES = ONBOARDING_AUDIO_MAX_BYTES;
const PDF_MAX_BYTES = ONBOARDING_PDF_MAX_BYTES;
const IMAGE_MAX_BYTES = ONBOARDING_IMAGE_MAX_BYTES;

const attachmentKindValidator = v.union(v.literal("site"), v.literal("pdf"), v.literal("imagem"), v.literal("audio"));

const messageViewValidator = v.object({
  _id: v.id("onboardingMessages"),
  role: v.union(v.literal("user"), v.literal("assistant")),
  text: v.string(),
  blocks: v.array(onboardingBlockValidator),
  chips: v.array(v.string()),
  attachment: v.union(
    v.object({ kind: attachmentKindValidator, label: v.string() }),
    v.null(),
  ),
  transcribed: v.boolean(),
  draftVersion: v.union(v.number(), v.null()),
  /**
   * P4.2b: resposta em áudio (só quando o usuário mandou áudio e a fala foi
   * gerada). `url` do storage gerada AQUI, depois do RBAC da sessão; ausente
   * quando não houve áudio ou ele já venceu (7 dias).
   */
  audio: v.optional(v.object({ url: v.string(), durationSec: v.number(), mimeType: v.string() })),
  createdAt: v.number(),
});

async function toMessageView(ctx: QueryCtx, m: Doc<"onboardingMessages">) {
  const audioUrl = m.audio ? await ctx.storage.getUrl(m.audio.storageId) : null;
  return {
    _id: m._id,
    role: m.role,
    text: m.text,
    blocks: m.blocks ?? [],
    chips: m.chips ?? [],
    // storageId fica fora da view: o front já tem o arquivo que enviou.
    attachment: m.attachment ? { kind: m.attachment.kind, label: m.attachment.label } : null,
    transcribed: m.transcribed === true,
    draftVersion: m.draftVersion ?? null,
    ...(m.audio && audioUrl ? { audio: { url: audioUrl, durationSec: m.audio.durationSec, mimeType: m.audio.mimeType } } : {}),
    createdAt: m.createdAt,
  };
}

/** D2: texto da recusa de material sem e-mail confirmado (a conversa por texto segue liberada). */
export const MATERIALS_NOTICE_REQUIRED_MESSAGE =
  "Antes do primeiro material, confirme que leu o aviso sobre como ele é lido (toque em \"Entendi\").";

export const MATERIALS_EMAIL_UNVERIFIED_MESSAGE =
  "Para eu ler site, PDF, imagem ou áudio, confirme primeiro o código que enviamos para o seu e-mail. Enquanto isso, podemos continuar por texto.";

const NO_PERMISSIONS: Permissions = {
  leads: "none",
  contacts: "none",
  inbox: "none",
  tasks: "none",
  reports: "none",
  team: "none",
  settings: "none",
  auditLogs: "none",
  apiKeys: "none",
  campaigns: "none",
};

const EMPTY_PAGE = { page: [], isDone: true, continueCursor: "" };
const LIST_PAGE_MAX = 50;

/** Recusa com código estável (o turno devolve `code` + `message`). */
function refuse(code: "forbidden" | "invalid_input" | "email_unverified" | "notice_required", message: string): never {
  throw new ConvexError({ code, message });
}

// ── Queries públicas (frontend) ─────────────────────────────────────────────

/**
 * Histórico da conversa, do mais NOVO para o mais antigo (o front inverte para
 * exibir). Não-membro recebe página vazia; membro sem `settings:manage`, erro;
 * sessão de outra org, "não encontrada".
 */
export const listMessages = query({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.id("onboardingSessions"),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(messageViewValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null())),
  }),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId || !(await getActiveMembership(ctx, args.organizationId, userId))) return EMPTY_PAGE;
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    await requireAccountWithEmail(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.organizationId !== args.organizationId) {
      throw new ConvexError("Sessão de onboarding não encontrada");
    }
    const result = await ctx.db
      .query("onboardingMessages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .paginate(
        args.paginationOpts.numItems > LIST_PAGE_MAX
          ? { ...args.paginationOpts, numItems: LIST_PAGE_MAX }
          : args.paginationOpts,
      );
    const page = await Promise.all(result.page.map((m) => toMessageView(ctx, m)));
    return { ...result, page };
  },
});

/** Estado para retomar a conversa: sessão, gates e as últimas sugestões. Não-membro = null. */
export const getChatState = query({
  args: { organizationId: v.id("organizations") },
  returns: v.union(
    v.null(),
    v.object({
      sessionId: v.union(v.id("onboardingSessions"), v.null()),
      stage: v.union(v.string(), v.null()),
      draftVersion: v.number(),
      draftHash: v.union(v.string(), v.null()),
      messageCount: v.number(),
      /** D2: e-mail confirmado libera site/PDF/imagem/áudio. */
      materialsUnlocked: v.boolean(),
      /** Ciência do aviso de materiais já dada nesta sessão (senão, mostrar `avisoMateriais`). */
      materialsNoticeAcknowledged: v.boolean(),
      aiActive: v.boolean(),
      lastChips: v.array(v.string()),
      /** E-mail da conta confirmado (mesmo que `materialsUnlocked`; nome pedido pela tela do roteiro). */
      emailVerified: v.boolean(),
      /** Endereço mascarado da conta ("bu…te@dominio.com"). */
      maskedEmail: v.union(v.string(), v.null()),
      /** Links guardados à espera da confirmação do e-mail. */
      pendingMaterials: v.number(),
      approvals: v.object({
        funnel: v.optional(v.string()),
        persona: v.optional(v.string()),
        knowledge: v.optional(v.string()),
      }),
      /** Etapa (0-based) mais avançada já alcançada. */
      reachedStep: v.number(),
      /** Existe rascunho aplicado. */
      applied: v.boolean(),
      tested: v.boolean(),
      /** Canal conectado ou "conectar depois" escolhido (`channelStepAt`). */
      connected: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId || !(await getActiveMembership(ctx, args.organizationId, userId))) return null;
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    await requireAccountWithEmail(ctx);
    const org = await ctx.db.get(args.organizationId);
    const session = await ctx.db
      .query("onboardingSessions")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .first();
    const last = session
      ? await ctx.db
          .query("onboardingMessages")
          .withIndex("by_session", (q) => q.eq("sessionId", session._id))
          .order("desc")
          .first()
      : null;
    const emailVerified = await isEmailVerifiedForMaterials(ctx, userId);
    const user = await ctx.db.get(userId);
    const aiActive = orgAiActive(org);
    const facts: RoadmapFacts = {
      draft: session?.draft ?? null,
      approvals: session?.approvals ?? {},
      aiActive,
      applied: session?.appliedDraftHash !== undefined,
      tested: session?.testedAt !== undefined,
      connected: session?.channelStepAt !== undefined,
      emailVerified,
      reachedStep: session?.reachedStep ?? 0,
    };
    return {
      sessionId: session?._id ?? null,
      stage: session?.stage ?? null,
      draftVersion: session?.draftVersion ?? 0,
      draftHash: session?.draftHash ?? null,
      messageCount: session?.messageCount ?? 0,
      materialsUnlocked: emailVerified,
      materialsNoticeAcknowledged: session?.materialsNoticeAckAt !== undefined,
      aiActive,
      lastChips: last?.role === "assistant" ? coherentChips(last.chips ?? [], facts) : [],
      emailVerified,
      maskedEmail: maskEmailForDisplay(user?.email) || null,
      pendingMaterials: session?.pendingMaterials?.length ?? 0,
      approvals: session?.approvals ?? {},
      reachedStep: facts.reachedStep ?? 0,
      applied: facts.applied,
      tested: facts.tested,
      connected: facts.connected,
    };
  },
});

// ── Aviso de materiais (clique) ─────────────────────────────────────────────

/**
 * Ciência do aviso antes do 1º material ("lido por IA de provedores parceiros,
 * inclusive fora do Brasil"). Só por este clique; idempotente (a 1ª ciência
 * vale). Audit `medium`.
 */
export const ackMaterialsNotice = mutation({
  args: { organizationId: v.id("organizations"), sessionId: v.id("onboardingSessions") },
  returns: v.object({ acknowledgedAt: v.number() }),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    await requireAccountWithEmail(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.organizationId !== args.organizationId) {
      throw new ConvexError("Sessão de onboarding não encontrada");
    }
    if (session.materialsNoticeAckAt !== undefined) return { acknowledgedAt: session.materialsNoticeAckAt };
    const now = Date.now();
    await ctx.db.patch(session._id, { materialsNoticeAckAt: now, materialsNoticeAckBy: member._id, updatedAt: now });
    const metadata = { action: "onboarding_materials_notice_ack" };
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "onboardingSession",
      entityId: session._id,
      action: "update",
      actorId: member._id,
      actorType: "human",
      metadata,
      description:
        "Deu ciência do aviso de materiais do onboarding (lidos por IA de provedores parceiros, inclusive fora do Brasil)",
      severity: "medium",
      createdAt: now,
    });
    return { acknowledgedAt: now };
  },
});

// ── Envio automático do código de e-mail (uma vez por sessão) ───────────────

/**
 * A conversa pede o código SOZINHA quando a conta ainda não confirmou o e-mail,
 * UMA vez por sessão (`emailCodeAutoSentAt` fica gravado mesmo se o envio for
 * recusado por limite; o reenvio é o botão do cartão, que usa
 * `requestEmailVerificationCode`). Mesmos limites do pedido manual
 * (`requestEmailVerificationCodeCore`). Nunca lança por falta de segredo ou limite.
 */
export const ensureEmailCodeSent = mutation({
  args: { organizationId: v.id("organizations"), sessionId: v.id("onboardingSessions") },
  returns: v.object({
    sent: v.boolean(),
    reason: v.optional(
      v.union(
        v.literal("already_verified"),
        v.literal("already_requested"),
        v.literal("cooldown"),
        v.literal("rate_limited"),
        v.literal("not_deliverable"),
        v.literal("unavailable"),
      ),
    ),
    canResendAt: v.optional(v.number()),
    maskedEmail: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    const user = await requireAccountWithEmail(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.organizationId !== args.organizationId) {
      throw new ConvexError("Sessão de onboarding não encontrada");
    }
    const maskedEmail = maskEmailForDisplay(user.email) || null;
    if (typeof user.emailVerificationTime === "number") return { sent: false, reason: "already_verified" as const, maskedEmail };
    if (session.emailCodeAutoSentAt !== undefined) return { sent: false, reason: "already_requested" as const, maskedEmail };
    await ctx.db.patch(session._id, { emailCodeAutoSentAt: Date.now() });
    const r = await requestEmailVerificationCodeCore(ctx, user);
    return {
      sent: r.sent,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.canResendAt !== undefined ? { canResendAt: r.canResendAt } : {}),
      maskedEmail,
    };
  },
});

// ── Turno sem stream (testes/ops) ───────────────────────────────────────────

/**
 * Um turno inteiro do onboarding, sem stream (mesmo loop do SSE). Interna: o
 * frontend usa só o SSE (que aplica o limite por IP). Erros voltam em
 * `{ok:false, code, message}` (PT-BR), nunca como exceção.
 */
export const internalSendTurn = internalAction({
  args: turnInputValidator,
  returns: turnResultValidator,
  handler: async (ctx, args): Promise<TurnResult> => {
    return await runOnboardingTurn(ctx, args, {});
  },
});

// ── Internas do loop ────────────────────────────────────────────────────────

/** Permissões do membro chamador (auth do request): alimenta o gate de rota HTTP. */
export const internalResolveTurnActor = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.union(v.null(), v.object({ userId: v.id("users"), permissions: v.any() })),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const member = await getActiveMembership(ctx, args.organizationId, userId);
    // Logado mas fora da org: nenhuma permissão (o gate de rota responde 403).
    const permissions: Permissions = member
      ? resolvePermissions(member.role as Role, member.permissions as Permissions | undefined)
      : NO_PERMISSIONS;
    return { userId, permissions };
  },
});

const prepareAttachmentValidator = v.union(
  v.object({ kind: v.literal("url"), url: v.string() }),
  v.object({ kind: v.literal("pdf"), storageId: v.id("_storage") }),
  v.object({ kind: v.literal("image"), storageId: v.id("_storage") }),
  v.object({ kind: v.literal("audio"), storageId: v.id("_storage") }),
);

/**
 * Abertura do turno (auth do request): D1 (conta com e-mail + `settings:manage`),
 * D2 (material só com e-mail confirmado), posse do arquivo (linha em `files`
 * DA ORG), sessão (a mais recente; cria se não houver) e o contexto que o
 * loop precisa. Recusa = `ConvexError` PT-BR, antes de qualquer LLM.
 */
export const internalPrepareTurn = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.optional(v.id("onboardingSessions")),
    attachment: v.optional(prepareAttachmentValidator),
  },
  returns: v.object({
    sessionId: v.id("onboardingSessions"),
    memberId: v.id("teamMembers"),
    userId: v.id("users"),
    stage: v.string(),
    draft: v.union(onboardingDraftValidator, v.null()),
    draftVersion: v.number(),
    appliedDraftHash: v.union(v.string(), v.null()),
    summary: v.union(v.string(), v.null()),
    messageCount: v.number(),
    emailVerified: v.boolean(),
    aiActive: v.boolean(),
    orgName: v.string(),
    orgSegment: v.union(v.string(), v.null()),
    history: v.array(
      v.object({
        role: v.union(v.literal("user"), v.literal("assistant")),
        text: v.string(),
        transcribed: v.boolean(),
      }),
    ),
    /** Roteamento da org SEM BYO (o onboarding usa a chave da plataforma): ZDR estrito e ordem de provedores. */
    routing: v.object({
      strictZdr: v.boolean(),
      platformOrder: v.optional(
        v.union(v.literal("auto"), v.literal("openrouter-first"), v.literal("opencode-only"), v.literal("openrouter-only")),
      ),
    }),
    file: v.union(
      v.null(),
      v.object({ size: v.number(), mimeType: v.string(), label: v.string() }),
    ),
    siteKey: v.union(v.string(), v.null()),
    materialsNoticeAck: v.boolean(),
    /** Link recebido ANTES da confirmação do e-mail: o turno só o guarda (nenhuma busca). */
    deferMaterial: v.boolean(),
    /** Roteiro: estado gravado na sessão. */
    approvals: v.object({
      funnel: v.optional(v.string()),
      persona: v.optional(v.string()),
      knowledge: v.optional(v.string()),
    }),
    shownCards: v.record(v.string(), v.string()),
    reachedStep: v.number(),
    tested: v.boolean(),
    connected: v.boolean(),
    pendingCount: v.number(),
    maskedEmail: v.union(v.string(), v.null()),
    /** Chave do evento da ÚLTIMA mensagem da sessão (idempotência de eventos). */
    lastEvent: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    let member: Doc<"teamMembers">;
    let user: Doc<"users">;
    try {
      member = await requirePermission(ctx, args.organizationId, "settings", "manage");
      user = await requireAccountWithEmail(ctx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      refuse(
        "forbidden",
        /Not authenticated/i.test(msg)
          ? "Entre na sua conta para continuar."
          : /e-mail/i.test(msg)
            ? "Esta ação exige uma conta com e-mail."
            : "Você não tem permissão para configurar esta organização.",
      );
    }
    const org = await ctx.db.get(args.organizationId);
    if (!org) refuse("invalid_input", "Organização não encontrada");
    const emailVerified = await isEmailVerifiedForMaterials(ctx, user._id);
    // Só LINK é guardado antes da confirmação (sem busca); arquivo continua recusado.
    if (args.attachment && !emailVerified && args.attachment.kind !== "url") {
      refuse("email_unverified", MATERIALS_EMAIL_UNVERIFIED_MESSAGE);
    }
    const deferMaterial = args.attachment?.kind === "url" && !emailVerified;

    let file: { size: number; mimeType: string; label: string } | null = null;
    let siteKey: string | null = null;
    if (args.attachment?.kind === "url") {
      const url = args.attachment.url.trim();
      if (url.length > 2000 || !/^https:\/\//i.test(url) || !siteKeyOf(url)) {
        refuse("invalid_input", "Envie um endereço que comece com https://");
      }
      siteKey = siteKeyOf(url);
    } else if (args.attachment) {
      const storageId = args.attachment.storageId;
      const rows = await ctx.db
        .query("files")
        .withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
        .take(20);
      const row = rows.find((r) => r.organizationId === args.organizationId);
      const meta = row ? await ctx.db.system.get(storageId) : null;
      if (!row || !meta) refuse("invalid_input", "Arquivo não encontrado");
      const mimeType = (meta.contentType ?? row.mimeType ?? "").split(";")[0].trim().toLowerCase();
      const kind = args.attachment.kind;
      const cap = kind === "audio" ? AUDIO_MAX_BYTES : kind === "pdf" ? PDF_MAX_BYTES : IMAGE_MAX_BYTES;
      if (meta.size > cap) {
        refuse(
          "invalid_input",
          kind === "audio"
            ? "Áudio longo demais: mande até uns 3 minutos (2 MB)."
            : `Arquivo grande demais (até ${Math.round(cap / 1024 / 1024)} MB).`,
        );
      }
      const okType =
        kind === "pdf" ? mimeType === "application/pdf" : kind === "image" ? mimeType.startsWith("image/") : mimeType.startsWith("audio/");
      if (!okType) refuse("invalid_input", "Tipo de arquivo não aceito para este envio");
      file = { size: meta.size, mimeType, label: (row.name ?? kind).slice(0, ATTACHMENT_LABEL_MAX) };
    }

    let session: Doc<"onboardingSessions">;
    if (args.sessionId) {
      const s = await ctx.db.get(args.sessionId);
      if (!s || s.organizationId !== args.organizationId) refuse("invalid_input", "Sessão de onboarding não encontrada");
      session = s;
    } else {
      session = await ensureOnboardingSession(ctx, args.organizationId, member);
    }
    // Aviso de materiais: o 1º material da sessão só depois da ciência explícita.
    if (args.attachment && !deferMaterial && session.materialsNoticeAckAt === undefined) {
      refuse("notice_required", MATERIALS_NOTICE_REQUIRED_MESSAGE);
    }
    const providerConfig = org.settings.aiConfig?.providerConfig;
    const recent = await ctx.db
      .query("onboardingMessages")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .order("desc")
      .take(HISTORY_FOR_PROMPT);
    const lastEvent = recent[0]?.event ?? null;
    return {
      sessionId: session._id,
      memberId: member._id,
      userId: user._id,
      stage: session.stage,
      draft: session.draft ?? null,
      draftVersion: session.draftVersion,
      appliedDraftHash: session.appliedDraftHash ?? null,
      summary: session.summary ?? null,
      messageCount: session.messageCount,
      emailVerified,
      aiActive: orgAiActive(org),
      orgName: org.name,
      orgSegment: org.onboardingMeta?.industry ?? null,
      history: recent.reverse().map((m) => ({ role: m.role, text: m.text, transcribed: m.transcribed === true })),
      routing: {
        strictZdr: providerConfig?.strictZdr === true,
        ...(providerConfig?.platformOrder ? { platformOrder: providerConfig.platformOrder } : {}),
      },
      file,
      siteKey,
      materialsNoticeAck: session.materialsNoticeAckAt !== undefined,
      deferMaterial,
      approvals: session.approvals ?? {},
      shownCards: session.shownCards ?? {},
      reachedStep: session.reachedStep ?? 0,
      tested: session.testedAt !== undefined,
      connected: session.channelStepAt !== undefined,
      pendingCount: session.pendingMaterials?.length ?? 0,
      maskedEmail: maskEmailForDisplay(user.email) || null,
      lastEvent,
    };
  },
});

/**
 * Reserva UMA página do site antes da busca (contador no servidor, teto de
 * 5 por site por sessão). Devolve quantas já tinham sido lidas (para o
 * `pagesReadForSite` do extrator).
 */
export const internalClaimSitePage = internalMutation({
  args: { organizationId: v.id("organizations"), sessionId: v.id("onboardingSessions"), siteKey: v.string() },
  returns: v.object({ ok: v.boolean(), pagesBefore: v.number() }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.organizationId !== args.organizationId) {
      throw new ConvexError("Sessão de onboarding não encontrada");
    }
    const row = await ctx.db
      .query("onboardingSiteReads")
      .withIndex("by_session_and_site", (q) => q.eq("sessionId", args.sessionId).eq("siteKey", args.siteKey))
      .unique();
    const before = row?.pages ?? 0;
    if (before >= MAX_PAGES_PER_SITE) return { ok: false, pagesBefore: before };
    const now = Date.now();
    if (row) await ctx.db.patch(row._id, { pages: before + 1, updatedAt: now });
    else {
      await ctx.db.insert("onboardingSiteReads", {
        organizationId: args.organizationId,
        sessionId: args.sessionId,
        siteKey: args.siteKey,
        pages: 1,
        updatedAt: now,
      });
    }
    return { ok: true, pagesBefore: before };
  },
});

/** Grava uma mensagem do histórico (texto cortado no teto; blocos e chips já montados pelo servidor). */
export const internalAppendMessage = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.id("onboardingSessions"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    text: v.string(),
    blocks: v.optional(v.array(onboardingBlockValidator)),
    chips: v.optional(v.array(v.string())),
    attachment: v.optional(
      v.object({ kind: attachmentKindValidator, label: v.string(), storageId: v.optional(v.id("_storage")) }),
    ),
    transcribed: v.optional(v.boolean()),
    draftVersion: v.optional(v.number()),
    /** Chave do evento determinístico que gerou a mensagem (idempotência). */
    event: v.optional(v.string()),
  },
  returns: v.id("onboardingMessages"),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.organizationId !== args.organizationId) {
      throw new ConvexError("Sessão de onboarding não encontrada");
    }
    const max = args.role === "assistant" ? REPLY_MAX + 200 : MESSAGE_TEXT_MAX;
    return await ctx.db.insert("onboardingMessages", {
      organizationId: args.organizationId,
      sessionId: args.sessionId,
      role: args.role,
      text: args.text.slice(0, max),
      ...(args.blocks && args.blocks.length > 0 ? { blocks: args.blocks.slice(0, 8) } : {}),
      ...(args.chips && args.chips.length > 0 ? { chips: args.chips.slice(0, CHIPS_STORED_MAX).map((c) => c.slice(0, 60)) } : {}),
      ...(args.attachment
        ? { attachment: { ...args.attachment, label: args.attachment.label.slice(0, ATTACHMENT_LABEL_MAX) } }
        : {}),
      ...(args.transcribed ? { transcribed: true } : {}),
      ...(args.draftVersion !== undefined ? { draftVersion: args.draftVersion } : {}),
      ...(args.event ? { event: args.event.slice(0, 200) } : {}),
      createdAt: Date.now(),
    });
  },
});

// ── Resposta em áudio (P4.2b) ───────────────────────────────────────────────

/** O áudio da resposta do onboarding some depois disto (blob + linha de `files` + campo). */
export const ONBOARDING_AUDIO_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const AUDIO_EXPIRE_BATCH = 100;

/**
 * Vincula o WAV gerado à mensagem do assistente (ou grava por que não houve
 * áudio). Confere org/sessão/papel da mensagem e que o arquivo é DA ORG; devolve
 * a URL do storage para o evento SSE `audio` (o turno já passou pelo RBAC da
 * sessão em `internalPrepareTurn`). Recusa = `{url:null}` e quem chama descarta
 * o arquivo.
 */
export const internalRecordReplyAudio = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.id("onboardingSessions"),
    messageId: v.id("onboardingMessages"),
    audio: v.optional(
      v.object({ fileId: v.id("files"), storageId: v.id("_storage"), durationSec: v.number(), mimeType: v.string() }),
    ),
    skipReason: v.optional(v.string()),
  },
  returns: v.object({ url: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const msg = await ctx.db.get(args.messageId);
    if (!msg || msg.organizationId !== args.organizationId || msg.sessionId !== args.sessionId || msg.role !== "assistant") {
      return { url: null };
    }
    if (!args.audio) {
      if (args.skipReason) await ctx.db.patch(msg._id, { audioSkipReason: args.skipReason.slice(0, 40) });
      return { url: null };
    }
    const file = await ctx.db.get(args.audio.fileId);
    if (!file || file.organizationId !== args.organizationId || file.storageId !== args.audio.storageId) return { url: null };
    await ctx.db.patch(msg._id, {
      audio: args.audio,
      audioExpiresAt: Date.now() + ONBOARDING_AUDIO_RETENTION_MS,
      audioSkipReason: undefined,
    });
    return { url: await ctx.storage.getUrl(args.audio.storageId) };
  },
});

/**
 * Cron diário: apaga o áudio vencido das respostas do onboarding (blob pela
 * porta `lib/fileRefs.ts`, linha de `files` por `deleteFileRow`) e tira o campo
 * da mensagem (o texto fica). Lotes de 100, auto-reagendado enquanto houver.
 */
export const internalExpireOnboardingAudio = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    if (cronsDisabled()) return 0;
    const now = Date.now();
    const rows = await ctx.db
      .query("onboardingMessages")
      .withIndex("by_audio_expires_at", (q) => q.gte("audioExpiresAt", 0).lte("audioExpiresAt", now))
      .take(AUDIO_EXPIRE_BATCH);
    for (const m of rows) {
      if (m.audio) {
        const file = await ctx.db.get(m.audio.fileId);
        if (file && file.organizationId === m.organizationId) {
          await deleteBlobIfUnreferenced(ctx, file);
          await deleteFileRow(ctx, file);
        }
      }
      await ctx.db.patch(m._id, { audio: undefined, audioExpiresAt: undefined });
    }
    if (rows.length === AUDIO_EXPIRE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.onboardingChat.internalExpireOnboardingAudio, {});
    }
    return rows.length;
  },
});

/**
 * Audit `low` da leitura de um material (um por material; sem URL, nome de
 * arquivo nem conteúdo — só tipo, resultado e contagens).
 */
export const internalLogMaterialRead = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.id("onboardingSessions"),
    memberId: v.id("teamMembers"),
    kind: attachmentKindValidator,
    status: v.union(v.literal("lido"), v.literal("falhou")),
    code: v.optional(v.string()),
    itemsAdded: v.number(),
    flagged: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.organizationId !== args.organizationId) return null;
    const metadata = {
      action: "onboarding_material_read",
      kind: args.kind,
      status: args.status,
      ...(args.code ? { code: args.code.slice(0, 40) } : {}),
      itemsAdded: args.itemsAdded,
      flagged: args.flagged,
    };
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "onboardingSession",
      entityId: args.sessionId,
      action: "update",
      actorId: args.memberId,
      actorType: "human",
      metadata,
      description: buildAuditDescription({ action: "update", entityType: "onboardingSession", metadata }),
      severity: "low",
      createdAt: Date.now(),
    });
    return null;
  },
});

// ── Roteiro: fatos conferidos no servidor e materiais guardados ──────────────

/** Canal de WhatsApp conectado (mesmo critério do snapshot de `onboarding.ts`): bridge `connected` ou Meta `active`. */
async function orgHasConnectedWhatsapp(ctx: QueryCtx, organizationId: Id<"organizations">): Promise<boolean> {
  const channels = await ctx.db
    .query("channelConfigs")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(100);
  return channels
    .filter((c) => c.channel === "whatsapp")
    .some((c) => (c.provider === "bridge" ? c.bridgeSessionState === "connected" : c.status === "active"));
}

/**
 * Evento `notify` do roteiro: o servidor CONFERE o fato antes de reconhecer (o
 * cliente nunca é a fonte). Devolve `{acknowledged}`; `false` = fato não
 * confirmado (quem chama responde com o passo atual). Escrita limitada a
 * `testedAt`, `channelStepAt` e `channelStepKind`.
 */
export const internalApplyNotify = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.id("onboardingSessions"),
    userId: v.id("users"),
    what: v.union(
      v.literal("email_verified"),
      v.literal("activated"),
      v.literal("tested"),
      v.literal("connected"),
      v.literal("skip_connect"),
    ),
  },
  returns: v.object({ acknowledged: v.boolean() }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.organizationId !== args.organizationId) {
      throw new ConvexError("Sessão de onboarding não encontrada");
    }
    const org = await ctx.db.get(args.organizationId);
    if (!org) return { acknowledged: false };
    const applied = session.appliedDraftHash !== undefined;
    const aiActive = orgAiActive(org);
    const now = Date.now();
    switch (args.what) {
      case "email_verified":
        return { acknowledged: await isEmailVerifiedForMaterials(ctx, args.userId) };
      case "activated":
        return { acknowledged: aiActive && applied };
      case "tested":
        if (!(aiActive && applied)) return { acknowledged: false };
        if (session.testedAt === undefined) await ctx.db.patch(session._id, { testedAt: now, updatedAt: now });
        return { acknowledged: true };
      case "connected":
        if (!(await orgHasConnectedWhatsapp(ctx, args.organizationId))) return { acknowledged: false };
        if (session.channelStepAt === undefined || session.channelStepKind !== "connected") {
          await ctx.db.patch(session._id, { channelStepAt: now, channelStepKind: "connected", updatedAt: now });
        }
        return { acknowledged: true };
      case "skip_connect":
        if (!(aiActive && applied)) return { acknowledged: false };
        if (session.channelStepAt === undefined) {
          await ctx.db.patch(session._id, { channelStepAt: now, channelStepKind: "skipped", updatedAt: now });
        }
        return { acknowledged: true };
    }
  },
});

const PENDING_MATERIALS_MAX = 3;

/**
 * Guarda um link recebido antes da confirmação do e-mail (dedupe por URL, teto
 * de 3; rótulo = host). `front` devolve à frente da fila um item retirado e não
 * lido. Nenhuma busca acontece aqui.
 */
export const internalAddPendingMaterial = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    sessionId: v.id("onboardingSessions"),
    url: v.string(),
    label: v.string(),
    front: v.optional(v.boolean()),
  },
  returns: v.object({ stored: v.boolean(), count: v.number() }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.organizationId !== args.organizationId) {
      throw new ConvexError("Sessão de onboarding não encontrada");
    }
    const list = session.pendingMaterials ?? [];
    if (list.some((m) => m.url === args.url)) return { stored: true, count: list.length };
    if (list.length >= PENDING_MATERIALS_MAX) return { stored: false, count: list.length };
    const item = { kind: "url" as const, url: args.url.slice(0, 2000), label: args.label.slice(0, 200), createdAt: Date.now() };
    const next = args.front ? [item, ...list] : [...list, item];
    await ctx.db.patch(session._id, { pendingMaterials: next, updatedAt: Date.now() });
    return { stored: true, count: next.length };
  },
});

/** Retira o PRIMEIRO material guardado (ou `null`). */
export const internalTakePendingMaterial = internalMutation({
  args: { organizationId: v.id("organizations"), sessionId: v.id("onboardingSessions") },
  returns: v.union(v.null(), v.object({ url: v.string(), label: v.string() })),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.organizationId !== args.organizationId) {
      throw new ConvexError("Sessão de onboarding não encontrada");
    }
    const list = session.pendingMaterials ?? [];
    if (list.length === 0) return null;
    const [first, ...rest] = list;
    await ctx.db.patch(session._id, { pendingMaterials: rest, updatedAt: Date.now() });
    return { url: first.url, label: first.label };
  },
});

export type PreparedTurn = {
  sessionId: Id<"onboardingSessions">;
  memberId: Id<"teamMembers">;
  userId: Id<"users">;
};
