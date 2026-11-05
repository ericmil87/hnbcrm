import { v, type Infer } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { query, mutation, internalQuery, QueryCtx, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { hasAccountEmail, isMembershipRevoked, requireAuth, requirePermission } from "./lib/auth";
import { buildAuditDescription } from "./lib/auditDescription";
import { canReplaceDefaultBoard, createBoardWithStagesCore } from "./lib/boardOps";
import { updateAgentProfileCore } from "./lib/attendantConfigOps";
import { SEGMENT_TEMPLATES } from "./lib/onboardingTemplates";
import {
  ONBOARDING_STEPS,
  deriveOnboardingStatus,
  type OnboardingSnapshot,
  type OnboardingStepKey,
  type SavedStepStatus,
} from "./lib/onboardingStatus";
import { hasPermission, resolvePermissions, type Permissions, type Role } from "./lib/permissions";

const wizardDataValidator = v.optional(v.any());

// Resposta para a org que NÃO tem registro em onboardingProgress mas já tem
// dados: quem já usa o produto não pode ver o wizard de novo. Os tipos são
// explícitos de propósito — sem eles os arrays inferem `never[]` e o consumidor
// (SpotlightTooltip) não consegue nem chamar `.includes(id)`; e sem
// `wizardData` a união com o documento real fica sem o campo, quebrando o
// OnboardingWizard.
const ALREADY_ONBOARDED: {
  wizardCompleted: boolean;
  checklistDismissed: boolean;
  seenSpotlights: string[];
  celebratedMilestones: string[];
  wizardCurrentStep: number;
  wizardData?: Record<string, unknown>;
} = {
  wizardCompleted: true,
  checklistDismissed: true,
  seenSpotlights: [],
  celebratedMilestones: [],
  wizardCurrentStep: 4,
};

// Quem decide se o assistente aparece é a ORG (`onboardingMeta.
// wizardCompletedAt`), não o registro do membro: o assistente configura o
// funil da empresa, só admin pode rodá-lo (`setupPipelineFromWizard`), e um
// agente convidado depois ficava preso nele sem saída. `shouldShowWizard` é a
// ÚNICA resposta que o front deve usar; a query nunca devolve null.
export const getOnboardingProgress = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);
    const org = await ctx.db.get(args.organizationId);

    const progress = await ctx.db
      .query("onboardingProgress")
      .withIndex("by_organization_and_member", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("teamMemberId", userMember._id)
      )
      .first();

    const shouldShowWizard = await computeShouldShowWizard(ctx, {
      organizationId: args.organizationId,
      isAdmin: userMember.role === "admin",
      orgWizardCompleted: !!org?.onboardingMeta?.wizardCompletedAt,
      deferred: !!org?.onboardingMeta?.wizardDeferredAt,
      memberWizardCompleted: progress ? progress.wizardCompleted : null,
    });

    if (progress) {
      // wizardCompleted coerente com a decisão, para quem ainda lê o campo.
      return {
        ...progress,
        wizardCompleted: shouldShowWizard ? progress.wizardCompleted : true,
        shouldShowWizard,
      };
    }

    if (shouldShowWizard) {
      return {
        wizardCompleted: false,
        checklistDismissed: false,
        seenSpotlights: [] as string[],
        celebratedMilestones: [] as string[],
        wizardCurrentStep: 0,
        shouldShowWizard: true,
      };
    }
    return { ...ALREADY_ONBOARDED, shouldShowWizard: false };
  },
});

/**
 * Regra do assistente: só admin, só org que ainda não concluiu. Sem registro
 * próprio, org que já tem lead ou contato conta como configurada (orgs
 * anteriores ao `wizardCompletedAt`). Com registro em andamento, o admin
 * continua de onde parou — os dados de exemplo do passo 2 não o expulsam.
 */
async function computeShouldShowWizard(
  ctx: QueryCtx,
  input: {
    organizationId: Id<"organizations">;
    isAdmin: boolean;
    orgWizardCompleted: boolean;
    /** "Continuar depois" (v2): `onboardingMeta.wizardDeferredAt`. */
    deferred?: boolean;
    memberWizardCompleted: boolean | null;
  },
): Promise<boolean> {
  // Org legada (wizardCompletedAt sem wizardVersion) nunca recebe o wizard à
  // força: `orgWizardCompleted` já cobre; o adiamento v2 também esconde.
  if (!input.isAdmin || input.orgWizardCompleted || input.deferred) return false;
  if (input.memberWizardCompleted !== null) return !input.memberWizardCompleted;

  const existingLead = await ctx.db
    .query("leads")
    .withIndex("by_organization", (q) => q.eq("organizationId", input.organizationId))
    .first();
  if (existingLead) return false;

  const existingContact = await ctx.db
    .query("contacts")
    .withIndex("by_organization", (q) => q.eq("organizationId", input.organizationId))
    .first();
  return !existingContact;
}

// ── Configuração inicial v2: status derivado de dados reais ──────────────────

type OnboardingMeta = NonNullable<Doc<"organizations">["onboardingMeta"]>;

const stepKeyValidator = v.union(
  v.literal("business"),
  v.literal("funnel"),
  v.literal("whatsapp"),
  v.literal("attendant"),
  v.literal("test"),
  v.literal("extras"),
  v.literal("team"),
);

const stepStatusValidator = v.union(
  v.literal("done"),
  v.literal("skipped"),
  v.literal("pending"),
);

const capabilitiesValidator = v.object({
  managedBridge: v.boolean(),
  transcription: v.boolean(),
  llm: v.boolean(),
  metaMessaging: v.boolean(),
});

/** Capacidades do deployment. Só booleanos: NUNCA devolve valor de env nem segredo. */
function platformCapabilities(org: Doc<"organizations"> | null) {
  const pc = org?.settings.aiConfig?.providerConfig;
  const byoConfigured = pc?.mode === "byo" && !!pc.byo;
  const env = (name: string) => !!process.env[name]?.trim();
  return {
    managedBridge:
      env("WA_BRIDGE_DEFAULT_URL") &&
      env("WA_BRIDGE_ADMIN_TOKEN") &&
      (process.env.WA_BRIDGE_HMAC_SECRET?.length ?? 0) >= 32,
    transcription: env("WHISPER_SERVICE_URL"),
    llm: env("OPENROUTER_API_KEY") || env("OPENCODE_GO_API") || byoConfigured,
    metaMessaging:
      env("META_MESSAGING_APP_ID") &&
      env("META_MESSAGING_APP_SECRET") &&
      env("META_MESSAGING_LOGIN_CONFIG_ID") &&
      env("META_MESSAGING_WEBHOOK_VERIFY_TOKEN"),
  };
}

/** Lê os dados reais (consultas por índice, limitadas) e monta o snapshot puro. */
async function loadOnboardingSnapshot(
  ctx: QueryCtx,
  org: Doc<"organizations">,
): Promise<OnboardingSnapshot> {
  const organizationId = org._id;
  const meta = org.onboardingMeta;
  const aiConfig = org.settings.aiConfig;

  const channels = await ctx.db
    .query("channelConfigs")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(100);
  const whatsapp = channels.filter((c) => c.channel === "whatsapp");
  const whatsappConnected = whatsapp.some((c) =>
    c.provider === "bridge" ? c.bridgeSessionState === "connected" : c.status === "active",
  );
  const hasBridgeChannel = whatsapp.some((c) => c.provider === "bridge" && c.status === "active");

  const aiMembers = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) =>
      q.eq("organizationId", organizationId).eq("type", "ai"),
    )
    .take(50);
  const attendantMember = aiMembers.find(
    (m) => m.status === "active" && m.agentProfile?.kind === "attendant",
  );
  const hasAttendant = !!attendantMember;

  const humans = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) =>
      q.eq("organizationId", organizationId).eq("type", "human"),
    )
    .take(20);
  const humanMemberCount = humans.filter((m) => !isMembershipRevoked(m)).length;

  const runs = await ctx.db
    .query("agentRuns")
    .withIndex("by_organization_and_kind_and_started", (q) =>
      q.eq("organizationId", organizationId).eq("kind", "attendant"),
    )
    .order("desc")
    .take(50);
  const firstAiReplyDone = runs.some((r) => r.status === "done" && r.resultMessageId !== undefined);

  const saved: OnboardingSnapshot["saved"] = {};
  for (const key of ONBOARDING_STEPS) {
    const st = meta?.steps?.[key];
    if (st) saved[key] = st.status;
  }

  return {
    hasBusinessOffer: !!meta?.business?.offer?.trim(),
    legacyWizardCompleted: !!meta?.wizardCompletedAt,
    legacyOrg: !!meta?.wizardCompletedAt && meta.wizardVersion !== 2,
    whatsappConnected,
    hasBridgeChannel,
    bridgeAiAckDone: aiConfig?.bridgeAiAck !== undefined,
    hasAttendant,
    attendant: attendantMember?.agentProfile
      ? { name: attendantMember.name, mode: attendantMember.agentProfile.mode }
      : null,
    aiActive: aiConfig?.enabled === true && aiConfig?.lgpdAck !== undefined,
    extrasEnabled:
      aiConfig?.visionEnabled === true || channels.some((c) => c.autoTranscribeAudio === true),
    humanMemberCount,
    firstAiReplyDone,
    saved,
  };
}

async function resolveShouldShowWizard(
  ctx: QueryCtx,
  member: Doc<"teamMembers">,
  org: Doc<"organizations"> | null,
): Promise<boolean> {
  const progress = await ctx.db
    .query("onboardingProgress")
    .withIndex("by_organization_and_member", (q) =>
      q.eq("organizationId", member.organizationId).eq("teamMemberId", member._id),
    )
    .first();
  return await computeShouldShowWizard(ctx, {
    organizationId: member.organizationId,
    isAdmin: member.role === "admin",
    orgWizardCompleted: !!org?.onboardingMeta?.wizardCompletedAt,
    deferred: !!org?.onboardingMeta?.wizardDeferredAt,
    memberWizardCompleted: progress ? progress.wizardCompleted : null,
  });
}

const REFERENCE_SCAN_LIMIT = 200;

// "Primeiros passos" do Painel (A.7): itens derivados de dados reais. Mantém o
// formato lido pelo front v1 (items[].id/label/completed, completedCount,
// totalCount, dismissed, celebratedMilestones); `step`/`target`/`skipped` são
// novos. Os ids `pipelineCustomized` e `teamMemberInvited` seguem os de antes.
export const getOnboardingChecklist = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);
    const org = await ctx.db.get(args.organizationId);

    const progress = await ctx.db
      .query("onboardingProgress")
      .withIndex("by_organization_and_member", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("teamMemberId", userMember._id),
      )
      .first();

    const snapshot = org ? await loadOnboardingSnapshot(ctx, org) : null;
    const status = snapshot ? deriveOnboardingStatus(snapshot) : null;
    const stepItem = (
      id: string,
      label: string,
      step: OnboardingStepKey,
    ): ChecklistItem => ({
      id,
      label,
      completed: status?.steps[step] === "done",
      skipped: status?.steps[step] === "skipped",
      step,
      target: "wizard",
    });

    const items: ChecklistItem[] = [
      stepItem("business", "Conte sobre seu negócio", "business"),
      stepItem("pipelineCustomized", "Monte seu funil", "funnel"),
      stepItem("whatsapp", "Conecte seu WhatsApp", "whatsapp"),
      stepItem("attendant", "Ligue o Atendente IA", "attendant"),
    ];
    if (status?.bridgeAckPending) {
      items.push({
        id: "bridgeAiAck",
        label: "Aceite o uso da IA no WhatsApp não oficial",
        completed: false,
        skipped: false,
        step: null,
        target: "settings_ai",
      });
    }
    items.push(
      stepItem("test", "Teste seu atendente", "test"),
      stepItem("extras", "Ouça áudios e leia imagens", "extras"),
      stepItem("teamMemberInvited", "Convide sua equipe", "team"),
      {
        id: "firstAiReply",
        label: "Primeira conversa respondida pela IA",
        completed: status?.firstAiReplyDone === true,
        skipped: false,
        step: null,
        target: "inbox",
      },
    );

    return {
      items,
      completedCount: items.filter((item) => item.completed).length,
      totalCount: items.length,
      dismissed: progress?.checklistDismissed ?? false,
      celebratedMilestones: progress?.celebratedMilestones ?? [],
    };
  },
});

interface ChecklistItem {
  id: string;
  label: string;
  completed: boolean;
  skipped: boolean;
  step: OnboardingStepKey | null;
  target: "wizard" | "settings_ai" | "inbox";
}

const statusDetailValidator = v.object({
  shouldShowWizard: v.boolean(),
  accountHasEmail: v.optional(v.boolean()),
  capabilities: v.optional(capabilitiesValidator),
  wizardVersion: v.optional(v.number()),
  /** Org que já concluiu o wizard v1: nunca recebe o wizard à força. */
  legacy: v.optional(v.boolean()),
  wizardDeferred: v.optional(v.boolean()),
  completed: v.optional(v.boolean()),
  segment: v.optional(v.string()),
  business: v.optional(
    v.object({
      displayName: v.optional(v.string()),
      offer: v.optional(v.string()),
      audience: v.optional(v.string()),
      tone: v.optional(
        v.union(v.literal("formal"), v.literal("amigavel"), v.literal("descontraido")),
      ),
      region: v.optional(v.string()),
    }),
  ),
  aiAssisted: v.optional(v.boolean()),
  // v.object (não v.record): v.record só aceita chaves v.string()/v.id() no push.
  steps: v.optional(
    v.object({
      business: stepStatusValidator,
      funnel: stepStatusValidator,
      whatsapp: stepStatusValidator,
      attendant: stepStatusValidator,
      test: stepStatusValidator,
      extras: stepStatusValidator,
      team: stepStatusValidator,
    }),
  ),
  nextStep: v.optional(v.union(stepKeyValidator, v.null())),
  bridgeAckPending: v.optional(v.boolean()),
  firstAiReplyDone: v.optional(v.boolean()),
});

export type StatusDetail = Infer<typeof statusDetailValidator>;

export async function buildStatusDetail(
  ctx: QueryCtx,
  org: Doc<"organizations">,
  shouldShowWizard: boolean,
  accountHasEmail: boolean,
  snapshot?: OnboardingSnapshot,
): Promise<StatusDetail> {
  const meta = org.onboardingMeta;
  const derived = deriveOnboardingStatus(snapshot ?? (await loadOnboardingSnapshot(ctx, org)));
  return {
    shouldShowWizard,
    accountHasEmail,
    capabilities: platformCapabilities(org),
    wizardVersion: meta?.wizardVersion,
    legacy: !!meta?.wizardCompletedAt && meta.wizardVersion !== 2,
    wizardDeferred: !!meta?.wizardDeferredAt,
    completed: derived.nextStep === null,
    segment: meta?.industry,
    business: meta?.business,
    aiAssisted: meta?.aiAssisted,
    steps: derived.steps,
    nextStep: derived.nextStep,
    bridgeAckPending: derived.bridgeAckPending,
    firstAiReplyDone: derived.firstAiReplyDone,
  };
}

// Estado completo da configuração inicial para o wizard v2. Membro sem
// `settings:view` (agente) recebe só `{ shouldShowWizard: false }`.
export const getOnboardingStatus = query({
  args: { organizationId: v.id("organizations") },
  returns: statusDetailValidator,
  handler: async (ctx, args): Promise<StatusDetail> => {
    const member = await requireAuth(ctx, args.organizationId);
    const permissions = resolvePermissions(
      member.role as Role,
      (member as { permissions?: Permissions }).permissions,
    );
    if (!hasPermission(permissions, "settings", "view")) {
      return { shouldShowWizard: false };
    }
    const org = await ctx.db.get(args.organizationId);
    if (!org) return { shouldShowWizard: false };
    const userId = await getAuthUserId(ctx);
    const user = userId ? await ctx.db.get(userId) : null;
    return await buildStatusDetail(
      ctx,
      org,
      await resolveShouldShowWizard(ctx, member, org),
      hasAccountEmail(user),
    );
  },
});

// Contexto do Copiloto em modo setup (fv2-20). Sem segredos: só o que o
// negócio já informou e o que falta configurar.
export const internalGetSetupContext = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.union(
    v.null(),
    v.object({
      organizationName: v.string(),
      timezone: v.string(),
      // Estado mascarado (fv2-20): só booleano/nome/modo; nunca telefone nem id.
      whatsappConnected: v.boolean(),
      attendant: v.union(
        v.null(),
        v.object({ name: v.string(), mode: v.union(v.literal("suggest"), v.literal("autopilot")) }),
      ),
      ...statusDetailValidator.fields,
    }),
  ),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    if (!org) return null;
    const snapshot = await loadOnboardingSnapshot(ctx, org);
    const detail = await buildStatusDetail(ctx, org, false, true, snapshot);
    return {
      organizationName: org.name,
      timezone: org.settings.timezone,
      whatsappConnected: snapshot.whatsappConnected,
      attendant: snapshot.attendant ?? null,
      ...detail,
    };
  },
});

const MAX_NAME = 80;
const MAX_OFFER = 600;
const MAX_AUDIENCE = 400;
const MAX_REGION = 80;

const SEGMENT_KEYS: readonly string[] = SEGMENT_TEMPLATES.map((t) => t.key);
const LEGACY_SEGMENTS: Record<string, string> = { financeiro: "servicos" };

function cut(value: string, max: number): string | undefined {
  const t = value.trim().slice(0, max).trim();
  return t.length > 0 ? t : undefined;
}

async function patchOnboardingMeta(
  ctx: MutationCtx,
  org: Doc<"organizations">,
  change: (meta: OnboardingMeta) => OnboardingMeta,
  now: number,
) {
  await ctx.db.patch(org._id, {
    onboardingMeta: change({ ...(org.onboardingMeta ?? {}) }),
    updatedAt: now,
  });
}

async function loadOrgOrThrow(ctx: MutationCtx, organizationId: Id<"organizations">) {
  const org = await ctx.db.get(organizationId);
  if (!org) throw new Error("Organização não encontrada");
  return org;
}

// Passo 1 da configuração inicial: segmento + perfil do negócio. NÃO liga
// `aiConfig.enabled` nem grava aceite LGPD: isso é clique humano em
// `setAiEnabled`.
export const saveBusinessProfile = mutation({
  args: {
    organizationId: v.id("organizations"),
    segment: v.string(),
    displayName: v.optional(v.string()),
    offer: v.optional(v.string()),
    audience: v.optional(v.string()),
    tone: v.optional(
      v.union(v.literal("formal"), v.literal("amigavel"), v.literal("descontraido")),
    ),
    region: v.optional(v.string()),
    aiAssisted: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const rawSegment = args.segment.trim().toLowerCase();
    const segment = LEGACY_SEGMENTS[rawSegment] ?? rawSegment;
    if (!SEGMENT_KEYS.includes(segment)) throw new Error("Segmento inválido");

    const org = await loadOrgOrThrow(ctx, args.organizationId);
    const now = Date.now();

    // Campo enviado vazio limpa; ausente mantém o que já estava salvo.
    const business = { ...(org.onboardingMeta?.business ?? {}) };
    const texts: Array<["displayName" | "offer" | "audience" | "region", string | undefined, number]> = [
      ["displayName", args.displayName, MAX_NAME],
      ["offer", args.offer, MAX_OFFER],
      ["audience", args.audience, MAX_AUDIENCE],
      ["region", args.region, MAX_REGION],
    ];
    for (const [key, value, max] of texts) {
      if (value === undefined) continue;
      const clean = cut(value, max);
      if (clean === undefined) delete business[key];
      else business[key] = clean;
    }
    if (args.tone !== undefined) business.tone = args.tone;

    await patchOnboardingMeta(
      ctx,
      org,
      (meta) => ({
        ...meta,
        industry: segment,
        business,
        ...(args.aiAssisted !== undefined ? { aiAssisted: args.aiAssisted } : {}),
        steps: business.offer
          ? { ...(meta.steps ?? {}), business: { status: "done", at: now } }
          : meta.steps,
      }),
      now,
    );

    // Sem os textos livres no log: só o segmento e quais campos vieram.
    const metadata = {
      action: "onboarding_business_saved",
      segment,
      aiAssisted: args.aiAssisted,
      fields: Object.keys(business),
    };
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "organization",
      entityId: args.organizationId,
      action: "update",
      actorId: member._id,
      actorType: "human",
      metadata,
      description: buildAuditDescription({ action: "update", entityType: "organization", metadata }),
      severity: "low",
      createdAt: now,
    });
    return null;
  },
});

const fieldSeedValidator = v.object({
  key: v.string(),
  name: v.string(),
  type: v.union(
    v.literal("text"),
    v.literal("number"),
    v.literal("boolean"),
    v.literal("date"),
    v.literal("select"),
    v.literal("multiselect"),
  ),
  options: v.optional(v.array(v.string())),
});

type FunnelStage = { name: string; color: string; isClosedWon?: boolean; isClosedLost?: boolean };

function stageSignature(s: FunnelStage): string {
  return JSON.stringify([s.name, s.color, !!s.isClosedWon, !!s.isClosedLost]);
}

// Funil da configuração inicial (A.5). Seguro e re-executável: board padrão
// vazio é substituído no lugar; com leads (ou org legada) cria um board novo.
// Nunca apaga board com lead, nem toca `leadSources` ou outros boards.
export const applyFunnelTemplate = mutation({
  args: {
    organizationId: v.id("organizations"),
    boardName: v.string(),
    boardColor: v.optional(v.string()),
    stages: v.array(
      v.object({
        name: v.string(),
        color: v.string(),
        isClosedWon: v.optional(v.boolean()),
        isClosedLost: v.optional(v.boolean()),
      }),
    ),
    fields: v.optional(v.array(fieldSeedValidator)),
  },
  returns: v.object({
    boardId: v.id("boards"),
    mode: v.union(v.literal("replaced"), v.literal("created")),
  }),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const org = await loadOrgOrThrow(ctx, args.organizationId);

    const boardName = args.boardName.trim();
    if (boardName.length < 1 || boardName.length > 60) {
      throw new Error("O nome do funil deve ter de 1 a 60 caracteres");
    }
    if (args.stages.length < 2 || args.stages.length > 12) {
      throw new Error("O funil precisa de 2 a 12 etapas");
    }
    const stages: FunnelStage[] = args.stages.map((s) => ({
      name: s.name.trim(),
      color: s.color,
      isClosedWon: s.isClosedWon === true,
      isClosedLost: s.isClosedLost === true,
    }));
    if (stages.some((s) => s.name.length < 1 || s.name.length > 60)) {
      throw new Error("Cada etapa precisa de um nome de 1 a 60 caracteres");
    }
    if (stages[0].isClosedWon || stages[0].isClosedLost) {
      throw new Error("A primeira etapa do funil precisa ser uma etapa aberta");
    }
    if (stages.some((s) => s.isClosedWon && s.isClosedLost)) {
      throw new Error("Uma etapa não pode ser ganha e perdida ao mesmo tempo");
    }
    if (stages.filter((s) => s.isClosedWon).length > 1 || stages.filter((s) => s.isClosedLost).length > 1) {
      throw new Error("O funil aceita no máximo uma etapa ganha e uma perdida");
    }
    const fields = args.fields ?? [];
    if (fields.length > 8) throw new Error("Use no máximo 8 campos");
    for (const f of fields) {
      if (!/^[a-z0-9_]{1,40}$/.test(f.key) || f.name.trim().length < 1 || f.name.length > 60) {
        throw new Error("Campo inválido: chave (a-z, 0-9, _) e nome são obrigatórios");
      }
      if ((f.options?.length ?? 0) > 30) throw new Error("Use no máximo 30 opções por campo");
    }

    const now = Date.now();
    const boards = await ctx.db
      .query("boards")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(100);
    const live = boards.filter((b) => b.archivedAt === undefined && b.deletionStartedAt === undefined);
    const defaultBoard = live.find((b) => b.isDefault);
    const legacyOrg = !!org.onboardingMeta?.wizardCompletedAt && org.onboardingMeta.wizardVersion !== 2;

    // O board padrão só é substituído se NINGUÉM depende dele: sem leads no
    // board nem em qualquer etapa, e sem regra de entrada de lead apontando
    // para as etapas.
    let oldStages: Doc<"stages">[] = [];
    let canReplace = !!defaultBoard && !legacyOrg;
    if (canReplace && defaultBoard) {
      const anyLead = await ctx.db
        .query("leads")
        .withIndex("by_board", (q) => q.eq("boardId", defaultBoard._id))
        .first();
      canReplace = !anyLead;
      if (canReplace) {
        oldStages = await ctx.db
          .query("stages")
          .withIndex("by_board_and_order", (q) => q.eq("boardId", defaultBoard._id))
          .take(100);
        for (const st of oldStages) {
          const lead = await ctx.db
            .query("leads")
            .withIndex("by_stage", (q) => q.eq("stageId", st._id))
            .first();
          if (lead) {
            canReplace = false;
            break;
          }
        }
        const routed = org.settings.inboundLeadRouting?.rules ?? [];
        if (routed.some((r) => oldStages.some((st) => st._id === r.stageId))) canReplace = false;
        // Formulários e campanhas não finalizadas também guardam `stageId`:
        // apagar a etapa faria o envio seguinte falhar e perder o lead.
        const isOld = (id: Id<"stages"> | undefined) =>
          id !== undefined && oldStages.some((st) => st._id === id);
        const forms = await ctx.db
          .query("forms")
          .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
          .take(REFERENCE_SCAN_LIMIT);
        if (forms.some((f) => isOld(f.settings.stageId))) canReplace = false;
        const campaigns = await ctx.db
          .query("campaigns")
          .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
          .take(REFERENCE_SCAN_LIMIT);
        // Lista cheia: pode haver referência além do limite; recusa a troca.
        if (!canReplaceDefaultBoard({ forms, campaigns, limit: REFERENCE_SCAN_LIMIT })) {
          canReplace = false;
        }
        if (
          campaigns.some(
            (c) =>
              !["completed", "canceled", "failed"].includes(c.status) &&
              isOld(c.audience.targetStageId),
          )
        ) {
          canReplace = false;
        }
      }
    }

    let boardId: Id<"boards">;
    let mode: "replaced" | "created";

    const sameStages =
      oldStages.length === stages.length &&
      oldStages.every((st, i) => stageSignature(st) === stageSignature(stages[i]));
    if (canReplace && defaultBoard && sameStages) {
      // Mesmo funil já aplicado: ids das etapas ficam estáveis, nada é recriado.
      mode = "replaced";
      boardId = defaultBoard._id;
      const color = args.boardColor ?? defaultBoard.color;
      if (defaultBoard.name !== boardName || defaultBoard.color !== color) {
        await ctx.db.patch(boardId, { name: boardName, color, updatedAt: now });
      }
    } else if (canReplace && defaultBoard) {
      mode = "replaced";
      boardId = defaultBoard._id;
      const removed = new Set<Id<"stages">>(oldStages.map((s) => s._id));
      for (const st of oldStages) await ctx.db.delete(st._id);
      await ctx.db.patch(boardId, {
        name: boardName,
        color: args.boardColor ?? defaultBoard.color,
        updatedAt: now,
      });
      let firstOpen: Id<"stages"> | undefined;
      for (let i = 0; i < stages.length; i++) {
        const s = stages[i];
        const id = await ctx.db.insert("stages", {
          organizationId: args.organizationId,
          boardId,
          name: s.name,
          color: s.color,
          order: i,
          isClosedWon: s.isClosedWon === true,
          isClosedLost: s.isClosedLost === true,
          createdAt: now,
          updatedAt: now,
        });
        if (!firstOpen && !s.isClosedWon && !s.isClosedLost) firstOpen = id;
      }
      await repointAttendants(ctx, member, removed, boardId, firstOpen);
      const metadata = {
        action: "onboarding_funnel_applied",
        mode,
        boardName,
        stageCount: stages.length,
        removedStageCount: removed.size,
      };
      await ctx.db.insert("auditLogs", {
        organizationId: args.organizationId,
        entityType: "board",
        entityId: boardId,
        action: "update",
        actorId: member._id,
        actorType: "human",
        metadata,
        description: buildAuditDescription({ action: "update", entityType: "board", metadata }),
        severity: "medium",
        createdAt: now,
      });
    } else {
      mode = "created";
      // Idempotência: mesmo payload de novo devolve o board criado antes.
      const wanted = stages.map(stageSignature).join("|");
      let existing: Id<"boards"> | undefined;
      for (const b of live.filter((x) => !x.isDefault && x.name === boardName)) {
        const have = await ctx.db
          .query("stages")
          .withIndex("by_board_and_order", (q) => q.eq("boardId", b._id))
          .take(100);
        if (have.map(stageSignature).join("|") === wanted) {
          existing = b._id;
          break;
        }
      }
      if (existing) {
        boardId = existing;
      } else {
        boardId = await createBoardWithStagesCore(ctx, {
          organizationId: args.organizationId,
          member,
          name: boardName,
          color: args.boardColor ?? "#3B82F6",
          stages,
          isDefault: defaultBoard ? false : undefined,
          auditAction: "onboarding_funnel_applied",
        });
      }
    }

    await upsertLeadFields(ctx, args.organizationId, fields, now);

    await patchOnboardingMeta(
      ctx,
      org,
      (meta) => ({
        ...meta,
        steps: { ...(meta.steps ?? {}), funnel: { status: "done", at: now } },
      }),
      now,
    );
    return { boardId, mode };
  },
});

/** Upsert por `key` (campos de lead); re-executar não duplica. */
async function upsertLeadFields(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  fields: Array<{ key: string; name: string; type: Doc<"fieldDefinitions">["type"]; options?: string[] }>,
  now: number,
) {
  if (fields.length === 0) return;
  const all = await ctx.db
    .query("fieldDefinitions")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(200);
  let nextOrder = Math.max(-1, ...all.map((f) => f.order)) + 1;
  for (const f of fields) {
    const found = all.find(
      (d) => d.key === f.key && (d.entityType === undefined || d.entityType === "lead"),
    );
    const name = f.name.trim();
    if (found) {
      // Só o nome: tipo/opções podem já estar em uso por leads existentes.
      await ctx.db.patch(found._id, { name });
    } else {
      await ctx.db.insert("fieldDefinitions", {
        organizationId,
        name,
        key: f.key,
        type: f.type,
        entityType: "lead",
        options: f.options,
        isRequired: false,
        order: nextOrder++,
        createdAt: now,
      });
    }
  }
}

/**
 * Atendentes cujo `pipelineConfig` apontava para etapas apagadas: o estágio
 * inicial vai para a 1ª etapa aberta do funil novo e o de pós-qualificação é
 * limpo. Passa pela porta única `updateAgentProfileCore` (audita, via wizard).
 */
async function repointAttendants(
  ctx: MutationCtx,
  member: Doc<"teamMembers">,
  removed: Set<Id<"stages">>,
  boardId: Id<"boards">,
  firstOpen: Id<"stages"> | undefined,
) {
  const agents = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) =>
      q.eq("organizationId", member.organizationId).eq("type", "ai"),
    )
    .take(50);
  for (const agent of agents) {
    const pc = agent.agentProfile?.pipelineConfig;
    if (!pc) continue;
    const initialGone = pc.initialStageId !== undefined && removed.has(pc.initialStageId);
    const qualifiedGone = pc.qualifiedStageId !== undefined && removed.has(pc.qualifiedStageId);
    if (!initialGone && !qualifiedGone) continue;
    const { initialStageId, qualifiedStageId, ...rest } = pc;
    await updateAgentProfileCore(ctx, {
      agent,
      member,
      via: "wizard",
      patch: {
        pipelineConfig: {
          ...rest,
          ...(initialGone
            ? firstOpen && (pc.boardId === undefined || pc.boardId === boardId)
              ? { initialStageId: firstOpen }
              : {}
            : initialStageId
              ? { initialStageId }
              : {}),
          ...(qualifiedGone ? {} : qualifiedStageId ? { qualifiedStageId } : {}),
        },
      },
    });
  }
}

// Marca só o que NÃO dá para derivar de dados: "testou", "revisou" e "pulou"
// de funil/WhatsApp/equipe/extras. Business e o "feito" do funil têm mutation própria.
export const markWizardStep = mutation({
  args: {
    organizationId: v.id("organizations"),
    step: stepKeyValidator,
    status: v.union(v.literal("done"), v.literal("skipped")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    const markable: Record<string, SavedStepStatus[]> = {
      test: ["done", "skipped"],
      funnel: ["skipped"], // "done" do funil vem de applyFunnelTemplate
      attendant: ["skipped"],
      whatsapp: ["skipped"],
      team: ["skipped"],
      extras: ["skipped"],
    };
    if (!markable[args.step]?.includes(args.status)) {
      throw new Error("Este passo é calculado a partir dos seus dados e não pode ser marcado");
    }
    const org = await loadOrgOrThrow(ctx, args.organizationId);
    const now = Date.now();
    await patchOnboardingMeta(
      ctx,
      org,
      (meta) => ({
        ...meta,
        steps: { ...(meta.steps ?? {}), [args.step]: { status: args.status, at: now } },
      }),
      now,
    );
    return null;
  },
});

// "Continuar depois": esconde o wizard automático; o Painel mostra o cartão.
export const deferWizard = mutation({
  args: { organizationId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    const org = await loadOrgOrThrow(ctx, args.organizationId);
    const now = Date.now();
    await patchOnboardingMeta(ctx, org, (meta) => ({ ...meta, wizardDeferredAt: now }), now);
    return null;
  },
});

export const reopenWizard = mutation({
  args: { organizationId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    const org = await loadOrgOrThrow(ctx, args.organizationId);
    await patchOnboardingMeta(
      ctx,
      org,
      (meta) => {
        const { wizardDeferredAt: _gone, ...rest } = meta;
        return rest;
      },
      Date.now(),
    );
    return null;
  },
});

// Initialize onboarding progress for the current user
export const initOnboardingProgress = mutation({
  args: { organizationId: v.id("organizations") },
  returns: v.id("onboardingProgress"),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    // Check if record already exists for this member+org
    const existing = await ctx.db
      .query("onboardingProgress")
      .withIndex("by_organization_and_member", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("teamMemberId", userMember._id)
      )
      .first();

    if (existing) {
      return existing._id;
    }

    const now = Date.now();

    const progressId = await ctx.db.insert("onboardingProgress", {
      organizationId: args.organizationId,
      teamMemberId: userMember._id,
      wizardCompleted: false,
      wizardCurrentStep: 0,
      checklistDismissed: false,
      seenSpotlights: [],
      celebratedMilestones: [],
      createdAt: now,
      updatedAt: now,
    });

    return progressId;
  },
});

// Update wizard step and optionally merge wizard data
export const updateWizardStep = mutation({
  args: {
    organizationId: v.id("organizations"),
    step: v.number(),
    wizardData: wizardDataValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const progress = await ctx.db
      .query("onboardingProgress")
      .withIndex("by_organization_and_member", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("teamMemberId", userMember._id)
      )
      .first();

    if (!progress) {
      throw new Error("Onboarding progress not found. Call initOnboardingProgress first.");
    }

    const now = Date.now();

    // Merge wizard data with existing data
    const mergedWizardData = args.wizardData
      ? { ...(progress.wizardData ?? {}), ...args.wizardData }
      : progress.wizardData;

    await ctx.db.patch(progress._id, {
      wizardCurrentStep: args.step,
      wizardData: mergedWizardData,
      updatedAt: now,
    });

    return null;
  },
});

// Complete the onboarding wizard
export const completeWizard = mutation({
  args: {
    organizationId: v.id("organizations"),
    // 2 = chamado pelo fluxo novo (configuração inicial v2); ausente = v1.
    version: v.optional(v.literal(2)),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const progress = await ctx.db
      .query("onboardingProgress")
      .withIndex("by_organization_and_member", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("teamMemberId", userMember._id)
      )
      .first();

    if (!progress) {
      throw new Error("Onboarding progress not found.");
    }

    const now = Date.now();

    // Mark wizard as completed
    await ctx.db.patch(progress._id, {
      wizardCompleted: true,
      wizardCurrentStep: 4,
      updatedAt: now,
    });

    // Só admin fecha o assistente da ORG; para os demais basta o registro
    // próprio (não deveriam nem ver o assistente — ver getOnboardingProgress).
    if (userMember.role !== "admin") return null;

    const existingOrg = await ctx.db.get(args.organizationId);

    // Patch organization with onboarding metadata and settings from wizard data
    const wizardData = progress.wizardData;
    await ctx.db.patch(args.organizationId, {
      // Preserva os campos v2 (business, steps…) já gravados; os do v1 só
      // sobrescrevem quando o wizard trouxe valor.
      onboardingMeta: {
        ...(existingOrg?.onboardingMeta ?? {}),
        ...(wizardData?.industry !== undefined ? { industry: wizardData.industry } : {}),
        ...(wizardData?.companySize !== undefined ? { companySize: wizardData.companySize } : {}),
        ...(wizardData?.mainGoal !== undefined ? { mainGoal: wizardData.mainGoal } : {}),
        wizardCompletedAt: now,
        ...(args.version === 2 ? { wizardVersion: 2 } : {}),
        wizardDeferredAt: undefined,
      },
      // Merge: o resto de settings (optOutKeywords, campaignDefaults…) fica.
      settings: {
        ...(existingOrg?.settings ?? {}),
        timezone: wizardData?.timezone ?? "America/Sao_Paulo",
        currency: wizardData?.currency ?? "BRL",
        // DDI padrão dos telefones (v0.67): só dígitos, 1–3; fora disso é
        // ignorado e fica o que a org já tinha (ausente = 55, ver lib/orgPhone).
        ...(typeof wizardData?.defaultCountryCode === "string" && /^\d{1,3}$/.test(wizardData.defaultCountryCode)
          ? { defaultCountryCode: wizardData.defaultCountryCode }
          : {}),
      },
      updatedAt: now,
    });

    // Audit log for organization update
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "organization",
      entityId: args.organizationId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      metadata: {
        action: "onboarding_wizard_completed",
        industry: wizardData?.industry,
        companySize: wizardData?.companySize,
        mainGoal: wizardData?.mainGoal,
      },
      description: buildAuditDescription({ action: "update", entityType: "organization", metadata: { action: "onboarding_wizard_completed", industry: wizardData?.industry, companySize: wizardData?.companySize, mainGoal: wizardData?.mainGoal } }),
      severity: "medium",
      createdAt: now,
    });

    return null;
  },
});

// LEGADO (wizard v1, some no PR 10 do Frontend v2): o funil da configuração
// inicial v2 passa só por `applyFunnelTemplate`. Remover num PR futuro depois
// de confirmar que nenhum cliente chama.
// Set up pipeline from wizard choices — replaces all boards/stages/lead sources
export const setupPipelineFromWizard = mutation({
  args: {
    organizationId: v.id("organizations"),
    boardName: v.string(),
    boardColor: v.optional(v.string()),
    stages: v.array(
      v.object({
        name: v.string(),
        color: v.string(),
        isClosedWon: v.optional(v.boolean()),
        isClosedLost: v.optional(v.boolean()),
      })
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);
    if (userMember.role !== "admin") {
      throw new Error("Not authorized. Only admins can set up pipelines.");
    }

    // Isto APAGA todos os boards/estágios/origens da org. Depois de concluído
    // (ex.: um segundo admin caindo no assistente) ou com leads pendurados nos
    // estágios, rodar de novo destruiria o funil em uso.
    const org = await ctx.db.get(args.organizationId);
    if (org?.onboardingMeta?.wizardCompletedAt) {
      throw new Error("O assistente desta organização já foi concluído. Ajuste o funil em Configurações.");
    }
    const anyLead = await ctx.db
      .query("leads")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .first();
    if (anyLead) {
      throw new Error("O funil já tem leads. Ajuste os estágios em Configurações.");
    }

    const now = Date.now();

    // Delete all existing stages for this org (query stages via boards)
    const existingBoards = await ctx.db
      .query("boards")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", args.organizationId)
      )
      .collect();

    for (const board of existingBoards) {
      const stages = await ctx.db
        .query("stages")
        .withIndex("by_board", (q) => q.eq("boardId", board._id))
        .collect();

      for (const stage of stages) {
        await ctx.db.delete(stage._id);
      }
    }

    // Delete all existing boards for this org
    for (const board of existingBoards) {
      await ctx.db.delete(board._id);
    }

    // Create new board
    const boardId = await ctx.db.insert("boards", {
      organizationId: args.organizationId,
      name: args.boardName,
      description: undefined,
      color: args.boardColor ?? "#3B82F6",
      isDefault: true,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Create stages in order
    for (let i = 0; i < args.stages.length; i++) {
      const stage = args.stages[i];
      await ctx.db.insert("stages", {
        organizationId: args.organizationId,
        boardId,
        name: stage.name,
        color: stage.color,
        order: i,
        isClosedWon: stage.isClosedWon ?? false,
        isClosedLost: stage.isClosedLost ?? false,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Replace lead sources with PT-BR defaults
    const existingSources = await ctx.db
      .query("leadSources")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", args.organizationId)
      )
      .collect();

    for (const source of existingSources) {
      await ctx.db.delete(source._id);
    }

    const defaultSources: Array<{ name: string; type: "website" | "social" | "email" | "phone" | "referral" | "api" }> = [
      { name: "Website", type: "website" },
      { name: "Redes Sociais", type: "social" },
      { name: "Campanha Email", type: "email" },
      { name: "Telefone", type: "phone" },
      { name: "Indicacao", type: "referral" },
      { name: "API", type: "api" },
    ];

    for (const source of defaultSources) {
      await ctx.db.insert("leadSources", {
        organizationId: args.organizationId,
        name: source.name,
        type: source.type,
        isActive: true,
        createdAt: now,
      });
    }

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "board",
      entityId: boardId,
      action: "create",
      actorId: userMember._id,
      actorType: "human",
      metadata: {
        action: "onboarding_pipeline_setup",
        boardName: args.boardName,
        stageCount: args.stages.length,
        stageNames: args.stages.map((s) => s.name),
      },
      description: buildAuditDescription({ action: "create", entityType: "board", metadata: { action: "onboarding_pipeline_setup", boardName: args.boardName, stageCount: args.stages.length, stageNames: args.stages.map((s) => s.name) } }),
      severity: "medium",
      createdAt: now,
    });

    return null;
  },
});

// Mark a spotlight tooltip as seen
export const markSpotlightSeen = mutation({
  args: {
    organizationId: v.id("organizations"),
    spotlightId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const progress = await ctx.db
      .query("onboardingProgress")
      .withIndex("by_organization_and_member", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("teamMemberId", userMember._id)
      )
      .first();

    if (!progress) {
      throw new Error("Onboarding progress not found.");
    }

    // Only add if not already present
    if (!progress.seenSpotlights.includes(args.spotlightId)) {
      await ctx.db.patch(progress._id, {
        seenSpotlights: [...progress.seenSpotlights, args.spotlightId],
        updatedAt: Date.now(),
      });
    }

    return null;
  },
});

// Mark a milestone celebration as acknowledged
export const markMilestoneCelebrated = mutation({
  args: {
    organizationId: v.id("organizations"),
    milestoneId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const progress = await ctx.db
      .query("onboardingProgress")
      .withIndex("by_organization_and_member", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("teamMemberId", userMember._id)
      )
      .first();

    if (!progress) {
      throw new Error("Onboarding progress not found.");
    }

    // Only add if not already present
    if (!progress.celebratedMilestones.includes(args.milestoneId)) {
      await ctx.db.patch(progress._id, {
        celebratedMilestones: [...progress.celebratedMilestones, args.milestoneId],
        updatedAt: Date.now(),
      });
    }

    return null;
  },
});

// Dismiss the onboarding checklist
export const dismissChecklist = mutation({
  args: { organizationId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const progress = await ctx.db
      .query("onboardingProgress")
      .withIndex("by_organization_and_member", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("teamMemberId", userMember._id)
      )
      .first();

    if (!progress) {
      throw new Error("Onboarding progress not found.");
    }

    await ctx.db.patch(progress._id, {
      checklistDismissed: true,
      updatedAt: Date.now(),
    });

    return null;
  },
});

// Generate sample data during onboarding (schedules internal mutation)
export const requestSampleData = mutation({
  args: {
    organizationId: v.id("organizations"),
    industry: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);
    if (userMember.role !== "admin") {
      throw new Error("Not authorized. Only admins can generate sample data.");
    }

    await ctx.scheduler.runAfter(0, internal.onboardingSeed.generateSampleData, {
      organizationId: args.organizationId,
      industry: args.industry,
    });

    return null;
  },
});

// Capacidades da plataforma neste deployment (o assistente e o Copiloto decidem
// o que oferecer). Só booleanos — NUNCA devolve valor de env nem segredo.
export const getPlatformCapabilities = query({
  args: { organizationId: v.id("organizations") },
  returns: capabilitiesValidator,
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);
    return platformCapabilities(await ctx.db.get(args.organizationId));
  },
});
