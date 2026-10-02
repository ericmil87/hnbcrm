/**
 * Motor de SIMULAÇÃO para orgs de demonstração (MVP "Central").
 *
 * GENÉRICO de propósito: nenhum nome de cliente/unidade mora aqui — todo
 * conteúdo (unidades, equipe, setores, funis, persona, roteiros) chega por
 * argumento, vindo de um cenário privado fora do git. Quem dirige é um script
 * de terminal (admin key) que chama estas funções `internal*`.
 *
 * Travas:
 *  - TODA função exige `settings.demoMode === true` na org. A única exceção é
 *    `internalEnsureDemoOrg`, que CRIA a org já com demoMode e recusa um slug
 *    que pertença a uma org sem demoMode (nunca "converte" uma org real).
 *  - Nada sai para a rede: as mensagens são gravadas direto (sem dispatch, sem
 *    fila do atendente), e o dispatch já curto-circuita org com demoMode.
 *  - Histórico retroativo: `at`/`createdAt` no passado entram em
 *    `createdAt`/`closedAt`/`firstInboundAt`…, que é o que o painel lê.
 *
 * Reusa os núcleos do backend: `transferConversationCore`,
 * `createHandoffCore`/`acceptHandoffCore`, `moveLeadToStageCore`,
 * `upsertRow` (adSpend) e a cascata de `lib/leadCascade`.
 */
import { v, ConvexError } from "convex/values";
import { internalMutation, internalQuery, MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { contactKindValidator, leadAttributionValidator } from "./schema";
import { normalizeCampaignKey } from "./lib/orgModules";
import { firstInboundPatch, firstResponsePatch } from "./lib/conversationTiming";
import { transferConversationCore } from "./lib/conversationTransfer";
import { moveLeadToStageCore } from "./lib/leadStageMove";
import { createHandoffCore, acceptHandoffCore } from "./handoffs";
import { upsertRow } from "./adSpend";
import { buildSearchText } from "./lib/searchText";
import {
  cascadeLeadChildren,
  deleteConversationCascade,
  newBudget,
  WriteBudget,
} from "./lib/leadCascade";
import { DEFAULT_STORED_MODELS } from "./lib/llm/registry";

export const MAX_OPS_PER_CALL = 50;
// Escritas por execução do reset. Cada escrita custa várias leituras (cascata
// por lead consulta ~10 índices): 1000 chegou a 3888 leituras de 4096.
const RESET_BUDGET = 400;
const STATUS_COUNT_CAP = 5000;

// ─── Guardas ────────────────────────────────────────────────────────────────

async function requireDemoOrg(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">
): Promise<Doc<"organizations">> {
  const org = await ctx.db.get(organizationId);
  if (!org) throw new ConvexError("Organização não encontrada");
  if (org.settings.demoMode !== true) {
    throw new ConvexError("demoSim: esta organização não é de demonstração (settings.demoMode)");
  }
  return org;
}

async function orgDoc<T extends "conversations" | "teamMembers" | "departments" | "units" | "boards" | "stages" | "handoffs">(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">,
  table: T,
  rawId: string
): Promise<Doc<T>> {
  const id = ctx.db.normalizeId(table, rawId);
  const doc = id ? ((await ctx.db.get(id)) as Doc<T> | null) : null;
  if (!doc || (doc as unknown as { organizationId: Id<"organizations"> }).organizationId !== organizationId) {
    throw new ConvexError(`demoSim: ${table} "${rawId}" não pertence à organização`);
  }
  return doc;
}

// ─── Setup ──────────────────────────────────────────────────────────────────

const scenarioValidator = v.object({
  org: v.object({
    name: v.string(),
    slug: v.string(),
    timezone: v.optional(v.string()),
    currency: v.optional(v.string()),
    // Respostas do assistente de onboarding (chaves de src/lib/onboardingTemplates).
    industry: v.optional(v.string()),
    companySize: v.optional(v.string()),
    mainGoal: v.optional(v.string()),
  }),
  units: v.array(
    v.object({
      key: v.string(),
      name: v.string(),
      shortName: v.optional(v.string()),
      city: v.optional(v.string()),
      state: v.optional(v.string()),
      kind: v.optional(v.string()),
      color: v.string(),
      status: v.union(v.literal("active"), v.literal("onboarding"), v.literal("inactive")),
      roomsCount: v.optional(v.number()),
      bookingUrl: v.optional(v.string()),
      whatsappLabel: v.optional(v.string()),
      description: v.optional(v.string()),
    })
  ),
  team: v.array(
    v.object({
      key: v.string(),
      name: v.string(),
      type: v.union(v.literal("human"), v.literal("ai")),
      role: v.union(v.literal("admin"), v.literal("manager"), v.literal("agent"), v.literal("ai")),
      title: v.optional(v.string()),
    })
  ),
  departments: v.array(
    v.object({
      key: v.string(),
      name: v.string(),
      description: v.optional(v.string()),
      color: v.string(),
      icon: v.optional(v.string()),
      memberKeys: v.array(v.string()),
      unitKeys: v.optional(v.array(v.string())),
      isEntry: v.optional(v.boolean()),
    })
  ),
  boards: v.array(
    v.object({
      key: v.string(),
      name: v.string(),
      isDefault: v.optional(v.boolean()),
      color: v.optional(v.string()),
      stages: v.array(
        v.object({
          key: v.string(),
          name: v.string(),
          color: v.string(),
          isClosedWon: v.optional(v.boolean()),
          isClosedLost: v.optional(v.boolean()),
        })
      ),
    })
  ),
  fields: v.array(
    v.object({
      key: v.string(),
      name: v.string(),
      type: v.union(
        v.literal("text"),
        v.literal("number"),
        v.literal("boolean"),
        v.literal("date"),
        v.literal("select"),
        v.literal("multiselect")
      ),
      entity: v.optional(v.union(v.literal("lead"), v.literal("contact"))),
      options: v.optional(v.array(v.string())),
    })
  ),
  labels: v.array(v.object({ name: v.string(), color: v.string() })),
  attendant: v.object({
    name: v.string(),
    systemPrompt: v.optional(v.string()),
    knowledge: v.optional(v.string()),
    // Id canônico do modelo do atendente (ausente = default da plataforma).
    model: v.optional(v.string()),
  }),
});

const entityRef = v.object({ key: v.optional(v.string()), name: v.string(), id: v.string() });

const demoMapValidator = v.object({
  organizationId: v.id("organizations"),
  slug: v.string(),
  name: v.string(),
  ownerMemberId: v.union(v.id("teamMembers"), v.null()),
  attendantMemberId: v.union(v.id("teamMembers"), v.null()),
  members: v.array(
    v.object({ name: v.string(), id: v.string(), type: v.union(v.literal("human"), v.literal("ai")), hasUser: v.boolean() })
  ),
  units: v.array(entityRef),
  departments: v.array(entityRef),
  boards: v.array(
    v.object({
      name: v.string(),
      id: v.string(),
      isDefault: v.boolean(),
      stages: v.array(
        v.object({ name: v.string(), id: v.string(), isClosedWon: v.boolean(), isClosedLost: v.boolean() })
      ),
    })
  ),
  labels: v.array(entityRef),
});

async function buildDemoMap(ctx: { db: QueryCtx["db"] }, org: Doc<"organizations">) {
  const orgId = org._id;
  const members = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization", (q) => q.eq("organizationId", orgId))
    .take(200);
  const active = members.filter((m) => m.removedAt === undefined && m.status !== "inactive");
  const owner = active.find((m) => m.userId && m.role === "admin") ?? null;
  const attendant = active.find((m) => m.type === "ai" && m.agentProfile?.kind === "attendant") ?? null;
  const units = await ctx.db.query("units").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).take(200);
  const departments = await ctx.db
    .query("departments")
    .withIndex("by_organization", (q) => q.eq("organizationId", orgId))
    .take(100);
  const boards = (
    await ctx.db.query("boards").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).take(50)
  ).filter((b) => b.archivedAt === undefined);
  const labels = await ctx.db
    .query("conversationLabels")
    .withIndex("by_organization", (q) => q.eq("organizationId", orgId))
    .take(200);
  const boardRows = [];
  for (const b of boards.sort((a, c) => a.order - c.order)) {
    const stages = await ctx.db
      .query("stages")
      .withIndex("by_board_and_order", (q) => q.eq("boardId", b._id))
      .collect();
    boardRows.push({
      name: b.name,
      id: b._id as string,
      isDefault: b.isDefault,
      stages: stages.map((s) => ({
        name: s.name,
        id: s._id as string,
        isClosedWon: s.isClosedWon,
        isClosedLost: s.isClosedLost,
      })),
    });
  }
  return {
    organizationId: orgId,
    slug: org.slug,
    name: org.name,
    ownerMemberId: owner?._id ?? null,
    attendantMemberId: attendant?._id ?? null,
    members: active.map((m) => ({ name: m.name, id: m._id as string, type: m.type, hasUser: !!m.userId })),
    units: units.sort((a, b) => a.order - b.order).map((u) => ({ name: u.name, id: u._id as string })),
    departments: departments.sort((a, b) => a.order - b.order).map((d) => ({ name: d.name, id: d._id as string })),
    boards: boardRows,
    labels: labels.map((l) => ({ name: l.name, id: l._id as string })),
  };
}

async function findOwnerUser(ctx: MutationCtx, email: string): Promise<Doc<"users">> {
  const exact = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .first();
  const lower = email.trim().toLowerCase();
  const user =
    exact ??
    (lower !== email
      ? await ctx.db
          .query("users")
          .withIndex("email", (q) => q.eq("email", lower))
          .first()
      : null);
  if (!user) throw new ConvexError(`demoSim: usuário "${email}" não encontrado`);
  return user;
}

/**
 * Cria ou ATUALIZA a org de demonstração (idempotente por slug; as entidades
 * casam por nome — reexecutar não duplica). Nunca cria canal de WhatsApp.
 */
export const internalEnsureDemoOrg = internalMutation({
  args: { ownerEmail: v.string(), scenario: scenarioValidator },
  returns: v.object({ created: v.boolean(), map: demoMapValidator }),
  handler: async (ctx, { ownerEmail, scenario }) => {
    const user = await findOwnerUser(ctx, ownerEmail);
    const now = Date.now();

    // ── Org ──
    let org = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", scenario.org.slug))
      .first();
    const created = !org;
    if (org && org.settings.demoMode !== true) {
      throw new ConvexError(
        `demoSim: o slug "${scenario.org.slug}" pertence a uma organização REAL (sem demoMode) — escolha outro`
      );
    }
    let orgId: Id<"organizations">;
    if (!org) {
      orgId = await ctx.db.insert("organizations", {
        name: scenario.org.name,
        slug: scenario.org.slug,
        settings: {
          timezone: scenario.org.timezone ?? "America/Sao_Paulo",
          currency: scenario.org.currency ?? "BRL",
          demoMode: true,
        },
        createdAt: now,
        updatedAt: now,
      });
    } else {
      orgId = org._id;
    }

    // ── Dono (admin com login) ──
    let owner = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_user", (q) => q.eq("organizationId", orgId).eq("userId", user._id))
      .first();
    if (!owner) {
      const ownerId = await ctx.db.insert("teamMembers", {
        organizationId: orgId,
        userId: user._id,
        name: user.name || user.email || "Admin",
        email: user.email,
        role: "admin",
        type: "human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      owner = (await ctx.db.get(ownerId))!;
    } else if (owner.removedAt !== undefined || owner.role !== "admin" || owner.status === "inactive") {
      await ctx.db.patch(owner._id, {
        role: "admin",
        status: "active",
        removedAt: undefined,
        removedBy: undefined,
        updatedAt: now,
      });
    }

    // ── Funis e estágios (casam por nome) ──
    const boards = await ctx.db.query("boards").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).take(50);
    const boardIdByKey = new Map<string, Id<"boards">>();
    const firstStageByBoard = new Map<string, Id<"stages">>();
    const defaultKey = scenario.boards.find((b) => b.isDefault)?.key ?? scenario.boards[0]?.key;
    for (const [index, b] of scenario.boards.entries()) {
      const existing = boards.find((row) => row.name === b.name);
      const fields = {
        name: b.name,
        color: b.color ?? "#3B82F6",
        isDefault: b.key === defaultKey,
        order: index,
        archivedAt: undefined,
        updatedAt: now,
      };
      let boardId: Id<"boards">;
      if (existing) {
        await ctx.db.patch(existing._id, fields);
        boardId = existing._id;
      } else {
        boardId = await ctx.db.insert("boards", { organizationId: orgId, ...fields, createdAt: now });
      }
      boardIdByKey.set(b.key, boardId);
      const stages = await ctx.db.query("stages").withIndex("by_board", (q) => q.eq("boardId", boardId)).collect();
      for (const [stageIndex, s] of b.stages.entries()) {
        const row = stages.find((st) => st.name === s.name);
        const stageFields = {
          name: s.name,
          color: s.color,
          order: stageIndex,
          isClosedWon: s.isClosedWon === true,
          isClosedLost: s.isClosedLost === true,
          updatedAt: now,
        };
        let stageId: Id<"stages">;
        if (row) {
          await ctx.db.patch(row._id, stageFields);
          stageId = row._id;
        } else {
          stageId = await ctx.db.insert("stages", {
            organizationId: orgId,
            boardId,
            ...stageFields,
            createdAt: now,
          });
        }
        if (stageIndex === 0) firstStageByBoard.set(b.key, stageId);
      }
    }
    // Um único default na org.
    for (const row of boards) {
      if (row.isDefault && ![...boardIdByKey.values()].includes(row._id)) {
        await ctx.db.patch(row._id, { isDefault: false, updatedAt: now });
      }
    }

    // ── Equipe fictícia (sem login, sem e-mail: nada chega a ninguém) ──
    const members = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", orgId))
      .take(200);
    const memberIdByKey = new Map<string, Id<"teamMembers">>();
    let attendantId: Id<"teamMembers"> | null = null;
    const defaultBoardId = defaultKey ? boardIdByKey.get(defaultKey) : undefined;
    const defaultFirstStage = defaultKey ? firstStageByBoard.get(defaultKey) : undefined;
    for (const t of scenario.team) {
      const existing = members.find((m) => m.name === t.name && !m.userId);
      const isAttendant = t.type === "ai" && attendantId === null;
      const agentProfile = isAttendant
        ? {
            ...(existing?.agentProfile ?? {}),
            kind: "attendant" as const,
            mode: "suggest" as const,
            systemPrompt: scenario.attendant.systemPrompt,
            knowledge: scenario.attendant.knowledge,
            language: "pt-BR",
            ...(defaultBoardId
              ? {
                  pipelineConfig: {
                    ...(existing?.agentProfile?.pipelineConfig ?? {}),
                    boardId: defaultBoardId,
                    ...(defaultFirstStage ? { initialStageId: defaultFirstStage } : {}),
                  },
                }
              : {}),
          }
        : undefined;
      const fields = {
        name: t.name,
        role: t.type === "ai" ? ("ai" as const) : t.role === "ai" ? ("agent" as const) : t.role,
        type: t.type,
        status: "active" as const,
        ...(agentProfile ? { agentProfile } : {}),
        updatedAt: now,
      };
      let id: Id<"teamMembers">;
      if (existing) {
        await ctx.db.patch(existing._id, { ...fields, removedAt: undefined });
        id = existing._id;
      } else {
        id = await ctx.db.insert("teamMembers", { organizationId: orgId, ...fields, createdAt: now });
      }
      memberIdByKey.set(t.key, id);
      if (isAttendant) attendantId = id;
    }

    // ── Unidades ──
    const units = await ctx.db.query("units").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).take(200);
    const unitIdByKey = new Map<string, Id<"units">>();
    for (const [index, u] of scenario.units.entries()) {
      const existing = units.find((row) => row.name === u.name);
      const { key: _key, ...rest } = u;
      const fields = { ...rest, order: index, updatedAt: now };
      if (existing) {
        await ctx.db.patch(existing._id, fields);
        unitIdByKey.set(u.key, existing._id);
      } else {
        unitIdByKey.set(u.key, await ctx.db.insert("units", { organizationId: orgId, ...fields, createdAt: now }));
      }
    }

    // ── Setores ──
    const departments = await ctx.db
      .query("departments")
      .withIndex("by_organization", (q) => q.eq("organizationId", orgId))
      .take(100);
    for (const [index, d] of scenario.departments.entries()) {
      const existing = departments.find((row) => row.name === d.name);
      const memberIds = d.memberKeys
        .map((k) => memberIdByKey.get(k))
        .filter((id): id is Id<"teamMembers"> => id !== undefined);
      const unitIds = (d.unitKeys ?? [])
        .map((k) => unitIdByKey.get(k))
        .filter((id): id is Id<"units"> => id !== undefined);
      const fields = {
        name: d.name,
        ...(d.description !== undefined ? { description: d.description } : {}),
        color: d.color,
        ...(d.icon !== undefined ? { icon: d.icon } : {}),
        memberIds,
        unitIds,
        isEntry: d.isEntry === true,
        order: index,
        updatedAt: now,
      };
      if (existing) await ctx.db.patch(existing._id, fields);
      else await ctx.db.insert("departments", { organizationId: orgId, ...fields, createdAt: now });
    }

    // ── Campos personalizados (casam por chave) ──
    for (const [index, f] of scenario.fields.entries()) {
      const entityType = f.entity ?? "lead";
      const existing = await ctx.db
        .query("fieldDefinitions")
        .withIndex("by_organization_and_entity_and_key", (q) =>
          q.eq("organizationId", orgId).eq("entityType", entityType).eq("key", f.key)
        )
        .first();
      const fields = {
        name: f.name,
        key: f.key,
        type: f.type,
        entityType,
        ...(f.options ? { options: f.options } : {}),
        isRequired: false,
        order: index,
      };
      if (existing) await ctx.db.patch(existing._id, fields);
      else await ctx.db.insert("fieldDefinitions", { organizationId: orgId, ...fields, createdAt: now });
    }

    // ── Etiquetas de conversa ──
    const labels = await ctx.db
      .query("conversationLabels")
      .withIndex("by_organization", (q) => q.eq("organizationId", orgId))
      .take(200);
    for (const l of scenario.labels) {
      const existing = labels.find((row) => row.name === l.name);
      if (existing) await ctx.db.patch(existing._id, { color: l.color });
      else await ctx.db.insert("conversationLabels", { organizationId: orgId, name: l.name, color: l.color, createdAt: now });
    }

    // ── Settings: módulos, demoMode, IA habilitada (atendente em sugestão) ──
    org = (await ctx.db.get(orgId))!;
    const currentAi = org.settings.aiConfig;
    const models = {
      ...DEFAULT_STORED_MODELS,
      ...(currentAi?.providerConfig?.models ?? {}),
      ...(scenario.attendant.model
        ? { attendant: scenario.attendant.model, classify: scenario.attendant.model }
        : {}),
    };
    await ctx.db.patch(orgId, {
      name: scenario.org.name,
      // Assistente de onboarding CONCLUÍDO: sem isto, depois do reset (org sem
      // lead nem contato) o dono cairia em "Vamos personalizar seu CRM".
      onboardingMeta: {
        industry: scenario.org.industry ?? org.onboardingMeta?.industry ?? "outro",
        companySize: scenario.org.companySize ?? org.onboardingMeta?.companySize ?? "21-50",
        mainGoal: scenario.org.mainGoal ?? org.onboardingMeta?.mainGoal ?? "atendimento",
        wizardCompletedAt: org.onboardingMeta?.wizardCompletedAt ?? now,
      },
      settings: {
        ...org.settings,
        timezone: scenario.org.timezone ?? org.settings.timezone,
        currency: scenario.org.currency ?? org.settings.currency,
        modules: { units: true, departments: true, attribution: true, central: true },
        demoMode: true,
        aiConfig: {
          ...(currentAi ?? {}),
          enabled: true,
          autoAssign: false,
          handoffThreshold: currentAi?.handoffThreshold ?? 0.8,
          lgpdAck: currentAi?.lgpdAck ?? { acceptedAt: now, acceptedBy: owner._id },
          copilotEnabled: true,
          attendantEnabled: true,
          providerConfig: {
            ...(currentAi?.providerConfig ?? {}),
            mode: currentAi?.providerConfig?.mode ?? "platform",
            zdr: currentAi?.providerConfig?.zdr ?? true,
            models,
          },
        },
      },
      updatedAt: now,
    });

    const progress = await ctx.db
      .query("onboardingProgress")
      .withIndex("by_organization_and_member", (q) =>
        q.eq("organizationId", orgId).eq("teamMemberId", owner._id)
      )
      .first();
    if (progress) {
      await ctx.db.patch(progress._id, { wizardCompleted: true, checklistDismissed: true, updatedAt: now });
    } else {
      await ctx.db.insert("onboardingProgress", {
        organizationId: orgId,
        teamMemberId: owner._id,
        wizardCompleted: true,
        wizardCurrentStep: 4,
        checklistDismissed: true,
        seenSpotlights: [],
        celebratedMilestones: [],
        createdAt: now,
        updatedAt: now,
      });
    }

    await ctx.db.insert("auditLogs", {
      organizationId: orgId,
      entityType: "organization",
      entityId: orgId,
      action: created ? "create" : "update",
      actorId: owner._id,
      actorType: "system",
      metadata: { via: "demoSim" },
      description: created
        ? "Organização de demonstração criada pelo simulador"
        : "Organização de demonstração atualizada pelo simulador",
      severity: "low",
      createdAt: now,
    });

    const finalOrg = (await ctx.db.get(orgId))!;
    return { created, map: await buildDemoMap(ctx, finalOrg) };
  },
});

// ─── Operações ──────────────────────────────────────────────────────────────

// Ids chegam como string: aceitam um id real OU "$<ref>" (conversa criada
// numa op anterior da MESMA chamada, pelo campo `ref`).
const demoMeta = v.optional(v.record(v.string(), v.any()));

const opValidator = v.union(
  v.object({
    type: v.literal("createContactLeadConversation"),
    ref: v.optional(v.string()),
    phone: v.string(),
    firstName: v.string(),
    lastName: v.optional(v.string()),
    company: v.optional(v.string()),
    title: v.optional(v.string()),
    boardId: v.string(),
    stageId: v.optional(v.string()),
    unitId: v.optional(v.string()),
    departmentId: v.optional(v.string()),
    conversationAssignedTo: v.optional(v.string()),
    leadAssignedTo: v.optional(v.string()),
    contactKind: v.optional(contactKindValidator),
    attribution: v.optional(
      v.object({ ...leadAttributionValidator.fields, capturedAt: v.optional(v.number()) })
    ),
    tags: v.optional(v.array(v.string())),
    temperature: v.optional(v.union(v.literal("cold"), v.literal("warm"), v.literal("hot"))),
    value: v.optional(v.number()),
    customFields: v.optional(v.record(v.string(), v.any())),
    createdAt: v.optional(v.number()),
  }),
  v.object({
    type: v.literal("addMessage"),
    conversationId: v.string(),
    direction: v.union(v.literal("inbound"), v.literal("outbound"), v.literal("internal")),
    senderType: v.union(v.literal("contact"), v.literal("human"), v.literal("ai")),
    senderId: v.optional(v.string()),
    content: v.string(),
    at: v.optional(v.number()),
    deliveryStatus: v.optional(
      v.union(v.literal("sent"), v.literal("delivered"), v.literal("read"), v.literal("failed"))
    ),
    demo: demoMeta,
  }),
  v.object({
    type: v.literal("setTyping"),
    conversationId: v.string(),
    state: v.union(v.literal("composing"), v.literal("paused")),
    at: v.optional(v.number()),
  }),
  v.object({
    type: v.literal("classify"),
    conversationId: v.string(),
    unitId: v.optional(v.union(v.string(), v.null())),
    contactKind: v.optional(contactKindValidator),
    tags: v.optional(v.array(v.string())),
    temperature: v.optional(v.union(v.literal("cold"), v.literal("warm"), v.literal("hot"))),
    attribution: v.optional(
      v.object({ ...leadAttributionValidator.fields, capturedAt: v.optional(v.number()) })
    ),
    value: v.optional(v.number()),
    customFields: v.optional(v.record(v.string(), v.any())),
    // Move o lead (sem fechar) — outro funil e/ou outro estágio aberto.
    boardId: v.optional(v.string()),
    stageId: v.optional(v.string()),
    byMemberId: v.optional(v.string()),
    at: v.optional(v.number()),
  }),
  v.object({
    type: v.literal("transfer"),
    conversationId: v.string(),
    toDepartmentId: v.optional(v.string()),
    toMemberId: v.optional(v.string()),
    note: v.optional(v.string()),
    byMemberId: v.string(),
    at: v.optional(v.number()),
  }),
  v.object({
    type: v.literal("handoffRequest"),
    conversationId: v.string(),
    fromMemberId: v.string(),
    toMemberId: v.optional(v.string()),
    reason: v.string(),
    summary: v.optional(v.string()),
    at: v.optional(v.number()),
  }),
  v.object({
    type: v.literal("handoffAccept"),
    conversationId: v.string(),
    memberId: v.string(),
    at: v.optional(v.number()),
  }),
  v.object({
    type: v.literal("outcome"),
    conversationId: v.string(),
    result: v.union(v.literal("won"), v.literal("lost")),
    reason: v.optional(v.string()),
    value: v.optional(v.number()),
    checkin: v.optional(v.string()),
    checkout: v.optional(v.string()),
    guests: v.optional(v.number()),
    byMemberId: v.string(),
    at: v.optional(v.number()),
  }),
  v.object({
    type: v.literal("archive"),
    conversationId: v.string(),
    archiveLead: v.optional(v.boolean()),
    at: v.optional(v.number()),
  }),
  v.object({
    type: v.literal("markRead"),
    conversationId: v.string(),
    at: v.optional(v.number()),
  })
);

type Op = typeof opValidator.type;

const opResultValidator = v.object({
  type: v.string(),
  conversationId: v.optional(v.string()),
  leadId: v.optional(v.string()),
  contactId: v.optional(v.string()),
  messageId: v.optional(v.string()),
  transferId: v.optional(v.string()),
  handoffId: v.optional(v.string()),
  skipped: v.optional(v.string()),
});
type OpResult = typeof opResultValidator.type;

type ApplyState = { orgId: Id<"organizations">; refs: Map<string, Id<"conversations">>; labels: Doc<"conversationLabels">[] | null };

function nowOr(at: number | undefined, fallback: number): number {
  return typeof at === "number" && Number.isFinite(at) ? Math.min(at, fallback) : fallback;
}

async function loadConversation(ctx: MutationCtx, state: ApplyState, raw: string) {
  if (raw.startsWith("$")) {
    const id = state.refs.get(raw.slice(1));
    if (!id) throw new ConvexError(`demoSim: referência "${raw}" desconhecida`);
    return await orgDoc(ctx, state.orgId, "conversations", id);
  }
  return await orgDoc(ctx, state.orgId, "conversations", raw);
}

async function labelIdsFor(ctx: MutationCtx, state: ApplyState, tags: string[]): Promise<Id<"conversationLabels">[]> {
  if (!state.labels) {
    state.labels = await ctx.db
      .query("conversationLabels")
      .withIndex("by_organization", (q) => q.eq("organizationId", state.orgId))
      .take(200);
  }
  const wanted = new Set(tags.map((t) => t.trim().toLowerCase()));
  return state.labels.filter((l) => wanted.has(l.name.trim().toLowerCase())).map((l) => l._id);
}

function completeAttribution(
  a: Omit<NonNullable<Doc<"leads">["attribution"]>, "capturedAt"> & { capturedAt?: number },
  at: number
): NonNullable<Doc<"leads">["attribution"]> {
  return {
    ...a,
    ...(a.campaignName && !a.campaignKey ? { campaignKey: normalizeCampaignKey(a.campaignName) } : {}),
    capturedAt: a.capturedAt ?? at,
  };
}

async function applyOp(ctx: MutationCtx, state: ApplyState, op: Op, realNow: number): Promise<OpResult> {
  const orgId = state.orgId;
  switch (op.type) {
    case "createContactLeadConversation": {
      const at = nowOr(op.createdAt, realNow);
      const board = await orgDoc(ctx, orgId, "boards", op.boardId);
      const stages = await ctx.db
        .query("stages")
        .withIndex("by_board_and_order", (q) => q.eq("boardId", board._id))
        .collect();
      const stage = op.stageId ? await orgDoc(ctx, orgId, "stages", op.stageId) : stages[0];
      if (!stage || stage.boardId !== board._id) throw new ConvexError("demoSim: estágio fora do funil");
      const unit = op.unitId ? await orgDoc(ctx, orgId, "units", op.unitId) : null;
      const dept = op.departmentId ? await orgDoc(ctx, orgId, "departments", op.departmentId) : null;
      const convAssignee = op.conversationAssignedTo
        ? await orgDoc(ctx, orgId, "teamMembers", op.conversationAssignedTo)
        : null;
      const leadAssignee = op.leadAssignedTo ? await orgDoc(ctx, orgId, "teamMembers", op.leadAssignedTo) : null;

      let contact = await ctx.db
        .query("contacts")
        .withIndex("by_organization_and_phone", (q) => q.eq("organizationId", orgId).eq("phone", op.phone))
        .first();
      if (!contact) {
        const base = {
          firstName: op.firstName,
          ...(op.lastName ? { lastName: op.lastName } : {}),
          ...(op.company ? { company: op.company } : {}),
          phone: op.phone,
        };
        const contactId = await ctx.db.insert("contacts", {
          organizationId: orgId,
          ...base,
          whatsappNumber: op.phone,
          tags: [],
          searchText: buildSearchText(base),
          createdAt: at,
          updatedAt: at,
        });
        contact = (await ctx.db.get(contactId))!;
      }
      const org = (await ctx.db.get(orgId))!;
      const title = op.title ?? ([op.firstName, op.lastName].filter(Boolean).join(" ") || op.phone);
      const leadId = await ctx.db.insert("leads", {
        organizationId: orgId,
        title,
        contactId: contact._id,
        boardId: board._id,
        stageId: stage._id,
        ...(leadAssignee ? { assignedTo: leadAssignee._id } : {}),
        value: op.value ?? 0,
        currency: org.settings.currency || "BRL",
        priority: "medium",
        temperature: op.temperature ?? "cold",
        tags: op.tags ?? [],
        customFields: op.customFields ?? {},
        conversationStatus: "new",
        ...(unit ? { unitId: unit._id } : {}),
        ...(op.contactKind ? { contactKind: op.contactKind } : {}),
        ...(op.attribution ? { attribution: completeAttribution(op.attribution, at) } : {}),
        lastActivityAt: at,
        createdAt: at,
        updatedAt: at,
      });
      await ctx.db.insert("activities", {
        organizationId: orgId,
        leadId,
        type: "created",
        actorType: "system",
        content: "Lead criado a partir de conversa no WhatsApp",
        metadata: { via: "demoSim" },
        createdAt: at,
      });
      const labelIds = op.tags?.length ? await labelIdsFor(ctx, state, op.tags) : [];
      const conversationId = await ctx.db.insert("conversations", {
        organizationId: orgId,
        leadId,
        kind: "direct",
        channel: "whatsapp",
        status: "active",
        ...(labelIds.length ? { labelIds } : {}),
        ...(unit ? { unitId: unit._id } : {}),
        ...(dept ? { departmentId: dept._id } : {}),
        ...(convAssignee ? { assignedTo: convAssignee._id } : {}),
        ...(op.contactKind ? { contactKind: op.contactKind } : {}),
        unreadCount: 0,
        messageCount: 0,
        createdAt: at,
        updatedAt: at,
      });
      if (op.ref) state.refs.set(op.ref, conversationId);
      return { type: op.type, conversationId, leadId, contactId: contact._id };
    }

    case "addMessage": {
      const conversation = await loadConversation(ctx, state, op.conversationId);
      const at = nowOr(op.at, realNow);
      const sender = op.senderId ? await orgDoc(ctx, orgId, "teamMembers", op.senderId) : null;
      if (op.senderType !== "contact" && !sender) {
        throw new ConvexError("demoSim: mensagem de equipe/IA precisa de senderId");
      }
      const inbound = op.direction === "inbound";
      const messageId = await ctx.db.insert("messages", {
        organizationId: orgId,
        conversationId: conversation._id,
        ...(conversation.leadId ? { leadId: conversation.leadId } : {}),
        direction: op.direction,
        ...(sender ? { senderId: sender._id } : {}),
        senderType: op.senderType,
        content: op.content,
        contentType: "text",
        ...(op.direction === "outbound" ? { deliveryStatus: op.deliveryStatus ?? "delivered" } : {}),
        isInternal: op.direction === "internal",
        metadata: { ...(op.demo ?? {}), demo: true },
        createdAt: at,
      });
      const patch: Partial<Doc<"conversations">> = {
        status: "active",
        lastMessageAt: Math.max(conversation.lastMessageAt ?? 0, at),
        messageCount: conversation.messageCount + 1,
        updatedAt: at,
      };
      if (inbound) {
        Object.assign(patch, {
          lastInboundAt: Math.max(conversation.lastInboundAt ?? 0, at),
          unreadCount: (conversation.unreadCount ?? 0) + 1,
          contactPresence: undefined,
          ...firstInboundPatch(conversation, at),
        });
      } else if (op.direction === "outbound") {
        Object.assign(patch, firstResponsePatch(conversation, op.senderType === "ai" ? "ai" : "human", at));
        // Humano respondendo = alguém leu a conversa.
        if (op.senderType === "human") Object.assign(patch, { unreadCount: 0, lastReadAt: at });
      }
      await ctx.db.patch(conversation._id, patch);
      if (conversation.leadId && op.direction !== "internal") {
        await ctx.db.patch(conversation.leadId, {
          lastActivityAt: at,
          updatedAt: at,
          conversationStatus: "active",
        });
      }
      return { type: op.type, conversationId: conversation._id, messageId };
    }

    case "setTyping": {
      const conversation = await loadConversation(ctx, state, op.conversationId);
      await ctx.db.patch(conversation._id, {
        contactPresence: { state: op.state, at: nowOr(op.at, realNow) },
      });
      return { type: op.type, conversationId: conversation._id };
    }

    case "classify": {
      const conversation = await loadConversation(ctx, state, op.conversationId);
      const at = nowOr(op.at, realNow);
      const lead = conversation.leadId ? await ctx.db.get(conversation.leadId) : null;
      const unit =
        op.unitId === undefined || op.unitId === null ? null : await orgDoc(ctx, orgId, "units", op.unitId);
      const convPatch: Partial<Doc<"conversations">> = { updatedAt: at };
      if (op.unitId !== undefined) convPatch.unitId = unit?._id;
      if (op.contactKind) convPatch.contactKind = op.contactKind;
      if (op.tags?.length) {
        const add = await labelIdsFor(ctx, state, op.tags);
        convPatch.labelIds = [...new Set([...(conversation.labelIds ?? []), ...add])];
      }
      await ctx.db.patch(conversation._id, convPatch);
      if (lead) {
        const leadPatch: Partial<Doc<"leads">> = { updatedAt: at, lastActivityAt: at };
        if (op.unitId !== undefined) leadPatch.unitId = unit?._id;
        if (op.contactKind) leadPatch.contactKind = op.contactKind;
        if (op.tags?.length) leadPatch.tags = [...new Set([...lead.tags, ...op.tags])];
        if (op.temperature) leadPatch.temperature = op.temperature;
        if (op.value !== undefined) leadPatch.value = op.value;
        if (op.customFields) leadPatch.customFields = { ...lead.customFields, ...op.customFields };
        // Primeiro toque: não sobrescreve a origem já gravada.
        if (op.attribution && !lead.attribution) leadPatch.attribution = completeAttribution(op.attribution, at);
        await ctx.db.patch(lead._id, leadPatch);

        if (op.boardId || op.stageId) {
          const board = op.boardId ? await orgDoc(ctx, orgId, "boards", op.boardId) : null;
          const boardId = board?._id ?? lead.boardId;
          let stage = op.stageId ? await orgDoc(ctx, orgId, "stages", op.stageId) : null;
          if (!stage) {
            stage =
              (await ctx.db
                .query("stages")
                .withIndex("by_board_and_order", (q) => q.eq("boardId", boardId))
                .first()) ?? null;
          }
          if (!stage || stage.boardId !== boardId) throw new ConvexError("demoSim: estágio fora do funil");
          if (stage._id !== lead.stageId) {
            const actor = await actorFor(ctx, orgId, op.byMemberId);
            await moveLeadToStageCore(ctx, {
              lead: (await ctx.db.get(lead._id))!,
              newStage: stage,
              newStageId: stage._id,
              actor,
              now: at,
              ...(boardId !== lead.boardId ? { extraPatch: { boardId } } : {}),
            });
          }
        }
      }
      return { type: op.type, conversationId: conversation._id, ...(lead ? { leadId: lead._id } : {}) };
    }

    case "transfer": {
      const conversation = await loadConversation(ctx, state, op.conversationId);
      if (!op.toDepartmentId && !op.toMemberId) throw new ConvexError("demoSim: transferência sem destino");
      const toDept = op.toDepartmentId ? await orgDoc(ctx, orgId, "departments", op.toDepartmentId) : null;
      const toMember = op.toMemberId ? await orgDoc(ctx, orgId, "teamMembers", op.toMemberId) : null;
      const actor = await orgDoc(ctx, orgId, "teamMembers", op.byMemberId);
      const transferId = await transferConversationCore(ctx, {
        conversation,
        toDept,
        toMember,
        actor,
        note: op.note?.trim().slice(0, 1000) || undefined,
        now: nowOr(op.at, realNow),
      });
      // Responsável do LEAD acompanha o da conversa (avatar da lista do inbox).
      if (toMember && conversation.leadId) {
        await ctx.db.patch(conversation.leadId, { assignedTo: toMember._id, updatedAt: nowOr(op.at, realNow) });
      }
      return { type: op.type, conversationId: conversation._id, transferId };
    }

    case "handoffRequest": {
      const conversation = await loadConversation(ctx, state, op.conversationId);
      const from = await orgDoc(ctx, orgId, "teamMembers", op.fromMemberId);
      const to = op.toMemberId ? await orgDoc(ctx, orgId, "teamMembers", op.toMemberId) : null;
      const at = nowOr(op.at, realNow);
      const handoffId = await createHandoffCore(ctx, {
        ...(conversation.leadId ? { leadId: conversation.leadId } : {}),
        organizationId: orgId,
        conversationId: conversation._id,
        fromMemberId: from._id,
        ...(to ? { toMemberId: to._id } : {}),
        reason: op.reason,
        ...(op.summary ? { summary: op.summary } : {}),
        suggestedActions: [],
        origin: from.type === "ai" ? "ai_tool" : "human",
        onDuplicate: "skip",
      });
      if (!handoffId) return { type: op.type, conversationId: conversation._id, skipped: "repasse já pendente" };
      // Carimbo retroativo (o núcleo usa o relógio real).
      if (at !== realNow) {
        await ctx.db.patch(handoffId, { createdAt: at });
        const lead = conversation.leadId ? await ctx.db.get(conversation.leadId) : null;
        if (lead?.handoffState) {
          await ctx.db.patch(lead._id, { handoffState: { ...lead.handoffState, requestedAt: at } });
        }
      }
      return { type: op.type, conversationId: conversation._id, handoffId };
    }

    case "handoffAccept": {
      const conversation = await loadConversation(ctx, state, op.conversationId);
      const member = await orgDoc(ctx, orgId, "teamMembers", op.memberId);
      const at = nowOr(op.at, realNow);
      const handoff = await ctx.db
        .query("handoffs")
        .withIndex("by_conversation_and_status", (q) =>
          q.eq("conversationId", conversation._id).eq("status", "pending")
        )
        .first();
      if (!handoff) {
        // Roteiro "humano assume" sem repasse aberto: só assume a conversa.
        await ctx.db.patch(conversation._id, {
          assignedTo: member._id,
          aiPausedUntil: Number.MAX_SAFE_INTEGER,
          updatedAt: at,
        });
        if (conversation.leadId) {
          await ctx.db.patch(conversation.leadId, { assignedTo: member._id, updatedAt: at });
        }
        return { type: op.type, conversationId: conversation._id, skipped: "sem repasse pendente — assumida" };
      }
      await acceptHandoffCore(ctx, { handoff, member });
      if (at !== realNow) await ctx.db.patch(handoff._id, { resolvedAt: at });
      // Responsável da CONVERSA também (fila do inbox).
      await ctx.db.patch(conversation._id, { assignedTo: member._id });
      return { type: op.type, conversationId: conversation._id, handoffId: handoff._id };
    }

    case "outcome": {
      const conversation = await loadConversation(ctx, state, op.conversationId);
      const lead = conversation.leadId ? await ctx.db.get(conversation.leadId) : null;
      if (!lead) throw new ConvexError("demoSim: conversa sem lead para o desfecho");
      const at = nowOr(op.at, realNow);
      const stages = await ctx.db
        .query("stages")
        .withIndex("by_board_and_order", (q) => q.eq("boardId", lead.boardId))
        .collect();
      const target = op.result === "won" ? stages.find((s) => s.isClosedWon) : stages.find((s) => s.isClosedLost);
      if (!target) throw new ConvexError("demoSim: funil sem estágio de ganho/perda");
      const customFields: Record<string, unknown> = { ...lead.customFields };
      if (op.checkin !== undefined) customFields.checkin = op.checkin;
      if (op.checkout !== undefined) customFields.checkout = op.checkout;
      if (op.guests !== undefined) customFields.hospedes = op.guests;
      const actor = await orgDoc(ctx, orgId, "teamMembers", op.byMemberId);
      await moveLeadToStageCore(ctx, {
        lead,
        newStage: target,
        newStageId: target._id,
        actor,
        closedReason: op.reason?.trim() || undefined,
        finalValue: op.value,
        extraPatch: { customFields },
        now: at,
      });
      return { type: op.type, conversationId: conversation._id, leadId: lead._id };
    }

    case "archive": {
      const conversation = await loadConversation(ctx, state, op.conversationId);
      const at = nowOr(op.at, realNow);
      await ctx.db.patch(conversation._id, {
        archivedAt: at,
        unreadCount: 0,
        contactPresence: undefined,
        updatedAt: at,
      });
      if (op.archiveLead && conversation.leadId) {
        await ctx.db.patch(conversation.leadId, { archivedAt: at, updatedAt: at });
      }
      return { type: op.type, conversationId: conversation._id };
    }

    case "markRead": {
      const conversation = await loadConversation(ctx, state, op.conversationId);
      await ctx.db.patch(conversation._id, { unreadCount: 0, lastReadAt: nowOr(op.at, realNow) });
      return { type: op.type, conversationId: conversation._id };
    }
  }
}

async function actorFor(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  raw: string | undefined
): Promise<Doc<"teamMembers">> {
  if (raw) return await orgDoc(ctx, orgId, "teamMembers", raw);
  const ai = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) => q.eq("organizationId", orgId).eq("type", "ai"))
    .first();
  if (!ai) throw new ConvexError("demoSim: informe byMemberId (org sem membro IA)");
  return ai;
}

/**
 * Executor de operações atômicas (todas na mesma transação: ou todas, ou
 * nenhuma). Até `MAX_OPS_PER_CALL` por chamada.
 */
export const internalApplyOps = internalMutation({
  args: { organizationId: v.id("organizations"), ops: v.array(opValidator) },
  returns: v.array(opResultValidator),
  handler: async (ctx, args) => {
    await requireDemoOrg(ctx, args.organizationId);
    if (args.ops.length > MAX_OPS_PER_CALL) {
      throw new ConvexError(`demoSim: no máximo ${MAX_OPS_PER_CALL} operações por chamada`);
    }
    const state: ApplyState = { orgId: args.organizationId, refs: new Map(), labels: null };
    const realNow = Date.now();
    const results: OpResult[] = [];
    for (const op of args.ops) {
      results.push(await applyOp(ctx, state, op, realNow));
    }
    return results;
  },
});

// ─── Investimento em mídia ──────────────────────────────────────────────────

export const internalSeedAdSpend = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    rows: v.array(
      v.object({
        date: v.string(),
        platform: v.union(v.literal("meta"), v.literal("google"), v.literal("other")),
        campaignName: v.string(),
        unitId: v.optional(v.string()),
        amount: v.number(),
        impressions: v.optional(v.number()),
        clicks: v.optional(v.number()),
      })
    ),
  },
  returns: v.object({ created: v.number(), updated: v.number() }),
  handler: async (ctx, args) => {
    const org = await requireDemoOrg(ctx, args.organizationId);
    if (args.rows.length > 1000) throw new ConvexError("demoSim: no máximo 1000 linhas por chamada");
    const now = Date.now();
    let created = 0;
    let updated = 0;
    for (const row of args.rows) {
      const unit = row.unitId ? await orgDoc(ctx, args.organizationId, "units", row.unitId) : null;
      const result = await upsertRow(
        ctx,
        args.organizationId,
        {
          date: row.date,
          platform: row.platform,
          campaignName: row.campaignName,
          ...(unit ? { unitId: unit._id } : {}),
          amount: row.amount,
          ...(row.impressions !== undefined ? { impressions: row.impressions } : {}),
          ...(row.clicks !== undefined ? { clicks: row.clicks } : {}),
        },
        org.settings.currency || "BRL",
        now
      );
      if (result.created) created++;
      else updated++;
    }
    return { created, updated };
  },
});

// ─── Reset (só dados de simulação; configuração fica) ───────────────────────

async function deleteOrgRows(
  ctx: MutationCtx,
  budget: WriteBudget,
  fetch: (n: number) => Promise<{ _id: Id<any> }[]>
): Promise<{ deleted: number; done: boolean }> {
  let deleted = 0;
  while (budget.left > 0) {
    const rows = await fetch(Math.min(budget.left, 200));
    if (rows.length === 0) return { deleted, done: true };
    for (const row of rows) {
      await ctx.db.delete(row._id);
      budget.left -= 1;
      deleted++;
    }
  }
  return { deleted, done: false };
}

/**
 * Apaga contatos, leads (com a cascata de `lib/leadCascade`: conversas,
 * mensagens, repasses, atividades), transferências, notificações e
 * investimento da org demo, em lotes; re-agenda a si mesmo até terminar.
 * Mantém org, equipe, funis, unidades, setores, persona e o onboarding
 * (`onboardingProgress`/`onboardingMeta`) — nada de configuração sai daqui.
 */
export const internalResetDemo = internalMutation({
  args: { organizationId: v.id("organizations") },
  returns: v.object({ deleted: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const orgId = args.organizationId;
    await requireDemoOrg(ctx, orgId);
    const budget = newBudget(RESET_BUDGET);
    const startBudget = budget.left;
    let deleted = 0;
    let done = true;

    // Leads + filhos (a cascata é idempotente; o lead só sai no fim dela).
    while (budget.left > 0) {
      const leads = await ctx.db
        .query("leads")
        .withIndex("by_organization", (q) => q.eq("organizationId", orgId))
        .take(10);
      if (leads.length === 0) break;
      for (const lead of leads) {
        if (!(await cascadeLeadChildren(ctx, lead._id, budget))) break;
        await ctx.db.delete(lead._id);
        budget.left -= 1;
      }
    }
    if (budget.left <= 0) done = false;

    // Conversas sem lead (não deveria haver, mas nada fica para trás).
    while (done && budget.left > 0) {
      const conversation = await ctx.db
        .query("conversations")
        .withIndex("by_organization", (q) => q.eq("organizationId", orgId))
        .first();
      if (!conversation) break;
      if (!(await deleteConversationCascade(ctx, conversation._id, budget))) done = false;
    }

    const plain: Array<(n: number) => Promise<{ _id: Id<any> }[]>> = [
      (n) => ctx.db.query("messages").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).take(n),
      (n) =>
        ctx.db
          .query("conversationTransfers")
          .withIndex("by_organization_and_created", (q) => q.eq("organizationId", orgId))
          .take(n),
      (n) => ctx.db.query("handoffs").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).take(n),
      (n) => ctx.db.query("activities").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).take(n),
      (n) => ctx.db.query("notifications").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).take(n),
      (n) => ctx.db.query("contacts").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).take(n),
      (n) =>
        ctx.db
          .query("adSpend")
          .withIndex("by_organization_and_date", (q) => q.eq("organizationId", orgId))
          .take(n),
    ];
    for (const fetch of plain) {
      if (!done || budget.left <= 0) {
        done = false;
        break;
      }
      const r = await deleteOrgRows(ctx, budget, fetch);
      deleted += r.deleted;
      if (!r.done) done = false;
    }

    deleted = Math.max(deleted, startBudget - budget.left);
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.demoSim.internalResetDemo, { organizationId: orgId });
    }
    return { deleted, done };
  },
});

// ─── Leitura ────────────────────────────────────────────────────────────────

async function countCapped(rows: Promise<unknown[]>): Promise<number> {
  return (await rows).length;
}

export const internalDemoStatus = internalQuery({
  args: { organizationId: v.optional(v.id("organizations")), slug: v.optional(v.string()) },
  returns: v.object({
    map: demoMapValidator,
    counts: v.object({
      contacts: v.number(),
      leads: v.number(),
      conversations: v.number(),
      openConversations: v.number(),
      messages: v.number(),
      transfers: v.number(),
      handoffs: v.number(),
      adSpend: v.number(),
      won: v.number(),
      lost: v.number(),
    }),
    countCap: v.number(),
  }),
  handler: async (ctx, args) => {
    let orgId = args.organizationId ?? null;
    if (!orgId && args.slug) {
      const org = await ctx.db
        .query("organizations")
        .withIndex("by_slug", (q) => q.eq("slug", args.slug!))
        .first();
      orgId = org?._id ?? null;
    }
    if (!orgId) throw new ConvexError("demoSim: organização não encontrada");
    const org = await requireDemoOrg(ctx, orgId);
    const id = orgId;
    const cap = STATUS_COUNT_CAP;
    const leads = await ctx.db.query("leads").withIndex("by_organization", (q) => q.eq("organizationId", id)).take(cap);
    const active = await ctx.db
      .query("conversations")
      .withIndex("by_organization_and_status", (q) => q.eq("organizationId", id).eq("status", "active"))
      .take(cap);
    return {
      map: await buildDemoMap(ctx, org),
      counts: {
        contacts: await countCapped(
          ctx.db.query("contacts").withIndex("by_organization", (q) => q.eq("organizationId", id)).take(cap)
        ),
        leads: leads.length,
        conversations: await countCapped(
          ctx.db.query("conversations").withIndex("by_organization", (q) => q.eq("organizationId", id)).take(cap)
        ),
        openConversations: active.filter((c) => !c.archivedAt).length,
        messages: await countCapped(
          ctx.db.query("messages").withIndex("by_organization", (q) => q.eq("organizationId", id)).take(cap)
        ),
        transfers: await countCapped(
          ctx.db
            .query("conversationTransfers")
            .withIndex("by_organization_and_created", (q) => q.eq("organizationId", id))
            .take(cap)
        ),
        handoffs: await countCapped(
          ctx.db.query("handoffs").withIndex("by_organization", (q) => q.eq("organizationId", id)).take(cap)
        ),
        adSpend: await countCapped(
          ctx.db.query("adSpend").withIndex("by_organization_and_date", (q) => q.eq("organizationId", id)).take(cap)
        ),
        won: leads.filter((l) => l.closedType === "won").length,
        lost: leads.filter((l) => l.closedType === "lost").length,
      },
      countCap: cap,
    };
  },
});

/**
 * Conversas abertas (não arquivadas, lead não fechado) com o marcador de
 * roteiro da última mensagem simulada — é o que o `continuar` do script usa
 * para retomar uma história de onde parou.
 */
export const internalListOpenConversations = internalQuery({
  args: { organizationId: v.id("organizations"), limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      conversationId: v.id("conversations"),
      leadId: v.union(v.id("leads"), v.null()),
      title: v.string(),
      unitId: v.union(v.id("units"), v.null()),
      departmentId: v.union(v.id("departments"), v.null()),
      assignedTo: v.union(v.id("teamMembers"), v.null()),
      leadAssignedTo: v.union(v.id("teamMembers"), v.null()),
      contactKind: v.string(),
      value: v.number(),
      lastMessageAt: v.union(v.number(), v.null()),
      lastSenderType: v.union(v.string(), v.null()),
      demo: v.union(v.record(v.string(), v.any()), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    await requireDemoOrg(ctx, args.organizationId);
    const limit = Math.max(1, Math.min(args.limit ?? 50, 200));
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_organization_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("status", "active")
      )
      .order("desc")
      .take(limit * 4);
    const out = [];
    for (const c of rows) {
      if (out.length >= limit) break;
      if (c.archivedAt || c.kind === "group") continue;
      const lead = c.leadId ? await ctx.db.get(c.leadId) : null;
      if (lead?.closedType || lead?.archivedAt) continue;
      const recent = await ctx.db
        .query("messages")
        .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", c._id))
        .order("desc")
        .take(30);
      const last = recent.find((m) => m.direction !== "internal") ?? null;
      const marked = recent.find((m) => m.metadata?.demo === true && typeof m.metadata?.story === "string");
      out.push({
        conversationId: c._id,
        leadId: lead?._id ?? null,
        title: lead?.title ?? "Conversa",
        unitId: c.unitId ?? null,
        departmentId: c.departmentId ?? null,
        assignedTo: c.assignedTo ?? null,
        leadAssignedTo: lead?.assignedTo ?? null,
        contactKind: c.contactKind ?? lead?.contactKind ?? "lead",
        value: lead?.value ?? 0,
        lastMessageAt: c.lastMessageAt ?? null,
        lastSenderType: last?.senderType ?? null,
        demo: marked?.metadata
          ? { story: marked.metadata.story, step: marked.metadata.step ?? null, vars: marked.metadata.vars ?? null }
          : null,
      });
    }
    return out;
  },
});
