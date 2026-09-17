/**
 * Copiloto in-app — threads, mensagens e o executor server-side de tools.
 *
 * Identidade/atribuição (v2 §3.5): o copiloto age COMO O USUÁRIO logado —
 * actorType:"human" + metadata.via:"copilot". O RBAC aplicado é o do usuário,
 * enforçado server-side via assertAgentCan (camada 1); o modelo nunca fornece
 * organizationId/teamMemberId (injetados aqui).
 *
 * A inferência (loop de tool_calls + streaming SSE) vive em copilotRuntime.ts;
 * este arquivo é o estado durável + a superfície de execução de tools.
 */
import { v } from "convex/values";
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  QueryCtx,
  MutationCtx,
} from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireAuth } from "./lib/auth";
import { assertAgentCan, orgAiActive } from "./lib/agentSecurity";
import {
  projectToolResult,
  toolSpecByName,
  COPILOT_READ_TOOLS,
  COPILOT_WRITE_TOOLS,
} from "./lib/agentTools";
import { buildAuditDescription } from "./lib/auditDescription";
import { buildSearchText } from "./lib/searchText";
import { batchGet } from "./lib/batchGet";
import { hardDeleteLead, scheduleLeadCascade } from "./lib/leadCascade";
import {
  listCampaignsHandler,
  getCampaignReportHandler,
  previewAudienceHandler,
  createCampaignHandler,
  addManualRecipientsHandler,
  pauseCampaignHandler,
  resumeCampaignHandler,
  cancelCampaignHandler,
} from "./campaigns";
import { normalizeIncludeKeys } from "./lib/campaignAudience";
import { configProvider } from "./channelConfigs";
// Grupos de WhatsApp (F4): executores num arquivo próprio — ver o cabeçalho de
// `lib/groupCopilotTools.ts` para o porquê.
import {
  confirmGroupPendingAction,
  isGroupPendingTool,
  isGroupReadTool,
  isGroupWriteTool,
  runGroupReadTool,
  runGroupWriteTool,
} from "./lib/groupCopilotTools";

const MAX_THREADS_PER_MEMBER = 50;
const HISTORY_LIMIT = 200;

// ── Threads (dono = o membro humano; ninguém mais lê) ──

export const createThread = mutation({
  args: { organizationId: v.id("organizations") },
  returns: v.id("copilotThreads"),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const now = Date.now();

    // Teto de threads por membro: recicla a mais antiga em vez de crescer sem fim.
    const existing = await ctx.db
      .query("copilotThreads")
      .withIndex("by_organization_and_member", (q) =>
        q.eq("organizationId", args.organizationId).eq("memberId", member._id)
      )
      .collect();
    if (existing.length >= MAX_THREADS_PER_MEMBER) {
      const oldest = existing.reduce((a, b) => (a.updatedAt < b.updatedAt ? a : b));
      const messages = await ctx.db
        .query("copilotMessages")
        .withIndex("by_thread_and_created", (q) => q.eq("threadId", oldest._id))
        .collect();
      for (const m of messages) await ctx.db.delete(m._id);
      await ctx.db.delete(oldest._id);
    }

    return await ctx.db.insert("copilotThreads", {
      organizationId: args.organizationId,
      memberId: member._id,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const listThreads = query({
  args: { organizationId: v.id("organizations") },
  returns: v.array(
    v.object({
      _id: v.id("copilotThreads"),
      title: v.optional(v.string()),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const threads = await ctx.db
      .query("copilotThreads")
      .withIndex("by_organization_and_member", (q) =>
        q.eq("organizationId", args.organizationId).eq("memberId", member._id)
      )
      .collect();
    threads.sort((a, b) => b.updatedAt - a.updatedAt);
    return threads.map((t) => ({ _id: t._id, title: t.title, updatedAt: t.updatedAt }));
  },
});

export const getThreadMessages = query({
  args: { threadId: v.id("copilotThreads") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) return [];
    const member = await requireAuth(ctx, thread.organizationId);
    if (thread.memberId !== member._id) throw new Error("Thread de outro usuário");

    const messages = await ctx.db
      .query("copilotMessages")
      .withIndex("by_thread_and_created", (q) => q.eq("threadId", args.threadId))
      .take(HISTORY_LIMIT);
    // A UI não renderiza mensagens role:"tool" cruas — só user/assistant.
    return messages.map((m) => ({
      _id: m._id,
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls?.map((tc) => ({ name: tc.name })),
      status: m.status,
      createdAt: m.createdAt,
    }));
  },
});

export const deleteThread = mutation({
  args: { threadId: v.id("copilotThreads") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) return null;
    const member = await requireAuth(ctx, thread.organizationId);
    if (thread.memberId !== member._id) throw new Error("Thread de outro usuário");

    const messages = await ctx.db
      .query("copilotMessages")
      .withIndex("by_thread_and_created", (q) => q.eq("threadId", args.threadId))
      .collect();
    for (const m of messages) await ctx.db.delete(m._id);
    await ctx.db.delete(args.threadId);
    return null;
  },
});

// ── Sessão do runtime (auth do usuário propagada do httpAction via runQuery) ──

// Resolve o usuário logado + gate de ativação da IA. O httpAction de streaming
// chama isto ANTES de qualquer tool — o copiloto age como o usuário, então sem
// sessão válida nada roda.
export const internalResolveSession = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new Error("Organização não encontrada");
    if (!orgAiActive(org)) {
      throw new Error("IA não está ativada nesta organização");
    }
    const aiConfig = org.settings.aiConfig!;
    // P3: toggle específico do copiloto sob o mestre (undefined = ligado).
    if (aiConfig.copilotEnabled === false) {
      throw new Error("O Copiloto está desativado nesta organização");
    }
    return {
      member: { _id: member._id, name: member.name, role: member.role },
      org: {
        name: org.name,
        currency: org.settings.currency,
        timezone: org.settings.timezone,
        industry: org.onboardingMeta?.industry ?? null,
      },
      providerConfig: aiConfig.providerConfig ?? null,
    };
  },
});

export const internalGetOrCreateThread = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    memberId: v.id("teamMembers"),
    threadId: v.optional(v.id("copilotThreads")),
  },
  returns: v.id("copilotThreads"),
  handler: async (ctx, args) => {
    if (args.threadId) {
      const thread = await ctx.db.get(args.threadId);
      if (!thread || thread.memberId !== args.memberId) {
        throw new Error("Thread de outro usuário");
      }
      return args.threadId;
    }
    const now = Date.now();
    return await ctx.db.insert("copilotThreads", {
      organizationId: args.organizationId,
      memberId: args.memberId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

// ── Persistência usada pelo runtime (internal) ──

export const internalGetThreadForRun = internalQuery({
  args: {
    threadId: v.id("copilotThreads"),
    memberId: v.id("teamMembers"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread || thread.memberId !== args.memberId) return null;
    const messages = await ctx.db
      .query("copilotMessages")
      .withIndex("by_thread_and_created", (q) => q.eq("threadId", args.threadId))
      .take(HISTORY_LIMIT);
    return { thread, messages };
  },
});

export const internalAppendMessage = internalMutation({
  args: {
    threadId: v.id("copilotThreads"),
    organizationId: v.id("organizations"),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("tool")),
    content: v.string(),
    toolCalls: v.optional(
      v.array(v.object({ id: v.string(), name: v.string(), arguments: v.string() }))
    ),
    toolCallId: v.optional(v.string()),
    status: v.optional(v.union(v.literal("streaming"), v.literal("done"), v.literal("error"))),
    agentRunId: v.optional(v.id("agentRuns")),
  },
  returns: v.id("copilotMessages"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const messageId = await ctx.db.insert("copilotMessages", {
      threadId: args.threadId,
      organizationId: args.organizationId,
      role: args.role,
      content: args.content,
      toolCalls: args.toolCalls,
      toolCallId: args.toolCallId,
      status: args.status,
      agentRunId: args.agentRunId,
      createdAt: now,
    });
    await ctx.db.patch(args.threadId, { updatedAt: now });
    return messageId;
  },
});

// Persistência incremental do streaming (fronteiras de sentença) + título lazy.
export const internalPatchMessage = internalMutation({
  args: {
    messageId: v.id("copilotMessages"),
    content: v.optional(v.string()),
    status: v.optional(v.union(v.literal("streaming"), v.literal("done"), v.literal("error"))),
    toolCalls: v.optional(
      v.array(v.object({ id: v.string(), name: v.string(), arguments: v.string() }))
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { messageId, ...patch } = args;
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined)
    );
    if (Object.keys(clean).length > 0) await ctx.db.patch(messageId, clean);
    return null;
  },
});

export const internalSetThreadTitle = internalMutation({
  args: { threadId: v.id("copilotThreads"), title: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.threadId, { title: args.title.slice(0, 80), updatedAt: Date.now() });
    return null;
  },
});

// ── Executor de tools de LEITURA (F1) ──
// Um único dispatcher estático: switch explícito por nome (nunca resolução
// dinâmica), assertAgentCan por tool, saída SEMPRE via projectToolResult.

export const internalRunCopilotReadTool = internalQuery({
  args: {
    name: v.string(),
    argsJson: v.string(),
    organizationId: v.id("organizations"),
    memberId: v.id("teamMembers"), // o teamMember HUMANO dono da sessão
    // "agora" vem da action (sem Date.now() em query) — usado por tools que
    // dependem de janela temporal (público de campanha).
    now: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const spec = toolSpecByName(args.name);
    if (!spec || !COPILOT_READ_TOOLS.some((t) => t.name === args.name)) {
      return { error: `Tool de leitura desconhecida: ${args.name}` };
    }

    // Camada 1: RBAC do usuário (o copiloto age como ele) + org do agente.
    const member = await assertAgentCan(
      ctx,
      args.memberId,
      spec.permission.category,
      spec.permission.level
    );
    if (member.organizationId !== args.organizationId) {
      throw new Error("Membro não pertence a esta organização");
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(args.argsJson || "{}");
    } catch {
      return { error: "Argumentos inválidos (JSON malformado)" };
    }

    const raw = await runReadTool(ctx, args.name, parsed, args.organizationId, {
      memberId: member._id,
      now: args.now ?? member.updatedAt,
    });
    if ("error" in raw) return raw;
    return projectToolResult(spec, raw);
  },
});

type ReadCtx = QueryCtx;

async function runReadTool(
  ctx: ReadCtx,
  name: string,
  toolArgs: Record<string, unknown>,
  organizationId: Id<"organizations">,
  scope: { memberId: Id<"teamMembers">; now: number }
): Promise<Record<string, unknown>> {
  switch (name) {
    case "listCampaigns":
      return await listCampaignsTool(ctx, organizationId, toolArgs, scope.memberId);
    case "getCampaignReport":
      return await getCampaignReportTool(ctx, organizationId, toolArgs, scope.memberId);
    case "previewCampaignAudience":
      return await previewCampaignAudienceTool(ctx, organizationId, toolArgs, scope);
    case "getPipelineOverview":
      return await getPipelineOverview(ctx, organizationId, toolArgs);
    case "listLeads":
      return await listLeadsTool(ctx, organizationId, toolArgs);
    case "getLeadDetail":
      return await getLeadDetailTool(ctx, organizationId, toolArgs);
    case "searchContacts":
      return await searchContactsTool(ctx, organizationId, toolArgs);
    case "getDashboardStats":
      return await getDashboardStatsTool(ctx, organizationId);
    case "listTeamMembers":
      return await listTeamMembersTool(ctx, organizationId);
    case "listBoardsAndStages":
      return await listBoardsAndStagesTool(ctx, organizationId);
    case "listQuickReplies":
      return await listQuickRepliesTool(ctx, organizationId);
    case "listTasks":
      return await listTasksTool(ctx, organizationId, toolArgs);
    default:
      // Grupos de WhatsApp (F4) — executores em `lib/groupCopilotTools.ts`.
      if (isGroupReadTool(name)) {
        return await runGroupReadTool(ctx, name, toolArgs, organizationId);
      }
      return { error: `Tool não implementada: ${name}` };
  }
}

async function loadBoardsWithStages(ctx: ReadCtx, organizationId: Id<"organizations">) {
  const boards = (
    await ctx.db
      .query("boards")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .collect()
  ).filter((b) => b.archivedAt === undefined);
  return await Promise.all(
    boards.map(async (board: Doc<"boards">) => {
      const stages = await ctx.db
        .query("stages")
        .withIndex("by_board_and_order", (q) => q.eq("boardId", board._id))
        .collect();
      return { board, stages };
    })
  );
}

async function getPipelineOverview(
  ctx: ReadCtx,
  organizationId: Id<"organizations">,
  toolArgs: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const boardsWithStages = await loadBoardsWithStages(ctx, organizationId);
  const filterName = typeof toolArgs.boardName === "string" ? toolArgs.boardName : undefined;
  const selected = filterName
    ? boardsWithStages.filter(
        ({ board }) => board.name.toLowerCase() === filterName.toLowerCase()
      )
    : boardsWithStages;

  const boards = await Promise.all(
    selected.map(async ({ board, stages }) => {
      const stageSummaries = await Promise.all(
        stages.map(async (stage: Doc<"stages">) => {
          const leads = await ctx.db
            .query("leads")
            .withIndex("by_organization_and_stage", (q) =>
              q.eq("organizationId", organizationId).eq("stageId", stage._id)
            )
            .take(500);
          const active = leads.filter((l: Doc<"leads">) => l.archivedAt === undefined);
          return {
            name: stage.name,
            leadCount: active.length,
            totalValue: active.reduce((sum: number, l: Doc<"leads">) => sum + l.value, 0),
          };
        })
      );
      return { name: board.name, isDefault: board.isDefault, stages: stageSummaries };
    })
  );
  return { boards };
}

async function listLeadsTool(
  ctx: ReadCtx,
  organizationId: Id<"organizations">,
  toolArgs: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const limit = Math.min(typeof toolArgs.limit === "number" ? toolArgs.limit : 25, 50);
  const leads = await ctx.db
    .query("leads")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .order("desc")
    .take(300);

  const [stageMap, memberMap, contactMap] = await Promise.all([
    batchGet(ctx.db, leads.map((l: Doc<"leads">) => l.stageId)),
    batchGet(ctx.db, leads.map((l: Doc<"leads">) => l.assignedTo)),
    batchGet(ctx.db, leads.map((l: Doc<"leads">) => l.contactId)),
  ]);

  const stageName = typeof toolArgs.stageName === "string" ? toolArgs.stageName.toLowerCase() : undefined;
  const assigneeName =
    typeof toolArgs.assigneeName === "string" ? toolArgs.assigneeName.toLowerCase() : undefined;
  const temperature = typeof toolArgs.temperature === "string" ? toolArgs.temperature : undefined;
  const priority = typeof toolArgs.priority === "string" ? toolArgs.priority : undefined;

  const filtered = leads
    .filter((l: Doc<"leads">) => l.archivedAt === undefined)
    .filter((l: Doc<"leads">) => {
      const stage = stageMap.get(l.stageId);
      const assignee = l.assignedTo ? memberMap.get(l.assignedTo) : null;
      if (stageName && stage?.name.toLowerCase() !== stageName) return false;
      if (assigneeName && !assignee?.name.toLowerCase().includes(assigneeName)) return false;
      if (temperature && l.temperature !== temperature) return false;
      if (priority && l.priority !== priority) return false;
      return true;
    })
    .slice(0, limit);

  return {
    totalShown: filtered.length,
    leads: filtered.map((l: Doc<"leads">) => {
      const contact = l.contactId ? contactMap.get(l.contactId) : null;
      return {
        id: l._id,
        title: l.title,
        stage: stageMap.get(l.stageId)?.name ?? null,
        value: l.value,
        currency: l.currency,
        priority: l.priority,
        temperature: l.temperature,
        assignee: l.assignedTo ? memberMap.get(l.assignedTo)?.name ?? null : null,
        contactName: contact
          ? `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || null
          : null,
        lastActivityAt: l.lastActivityAt,
      };
    }),
  };
}

async function getLeadDetailTool(
  ctx: ReadCtx,
  organizationId: Id<"organizations">,
  toolArgs: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const leadId = typeof toolArgs.leadId === "string" ? toolArgs.leadId : null;
  if (!leadId) return { error: "leadId é obrigatório" };
  const lead = await ctx.db.get(leadId as Id<"leads">).catch(() => null);
  // Guarda de org: id de outra org responde como inexistente.
  if (!lead || lead.organizationId !== organizationId) return { error: "Lead não encontrado" };

  const [contact, stage, board, assignee] = await Promise.all([
    lead.contactId ? ctx.db.get(lead.contactId) : null,
    ctx.db.get(lead.stageId),
    ctx.db.get(lead.boardId),
    lead.assignedTo ? ctx.db.get(lead.assignedTo) : null,
  ]);
  const activities = await ctx.db
    .query("activities")
    .withIndex("by_lead_and_created", (q) => q.eq("leadId", lead._id))
    .order("desc")
    .take(10);

  return {
    lead: {
      id: lead._id,
      title: lead.title,
      board: board?.name ?? null,
      stage: stage?.name ?? null,
      value: lead.value,
      currency: lead.currency,
      priority: lead.priority,
      temperature: lead.temperature,
      qualification: lead.qualification ?? null,
      assignee: assignee?.name ?? null,
      tags: lead.tags,
      contact: contact
        ? {
            name: `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || null,
            email: contact.email ?? null,
            phone: contact.phone ?? null,
            company: contact.company ?? null,
          }
        : null,
    },
    timeline: activities.map((a: Doc<"activities">) => ({
      type: a.type,
      content: a.content ?? null,
      at: a.createdAt,
    })),
  };
}

async function searchContactsTool(
  ctx: ReadCtx,
  organizationId: Id<"organizations">,
  toolArgs: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const query = typeof toolArgs.query === "string" ? toolArgs.query.trim() : "";
  if (query.length < 2) return { error: "Busca precisa de ao menos 2 caracteres" };
  const limit = Math.min(typeof toolArgs.limit === "number" ? toolArgs.limit : 10, 25);

  const contacts = await ctx.db
    .query("contacts")
    .withSearchIndex("search_contacts", (q) =>
      q.search("searchText", query).eq("organizationId", organizationId)
    )
    .take(limit);

  return {
    contacts: contacts.map((c: Doc<"contacts">) => ({
      id: c._id,
      name: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || null,
      email: c.email ?? null,
      phone: c.phone ?? null,
      company: c.company ?? null,
      city: c.city ?? null,
      tags: c.tags,
    })),
  };
}

async function getDashboardStatsTool(
  ctx: ReadCtx,
  organizationId: Id<"organizations">
): Promise<Record<string, unknown>> {
  const leads = await ctx.db
    .query("leads")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(1000);
  const active = leads.filter((l: Doc<"leads">) => l.archivedAt === undefined);
  const open = active.filter((l: Doc<"leads">) => !l.closedAt);
  const won = active.filter((l: Doc<"leads">) => l.closedType === "won");
  const lost = active.filter((l: Doc<"leads">) => l.closedType === "lost");

  return {
    stats: {
      totalLeads: active.length,
      openLeads: open.length,
      openValue: open.reduce((sum: number, l: Doc<"leads">) => sum + l.value, 0),
      wonLeads: won.length,
      wonValue: won.reduce((sum: number, l: Doc<"leads">) => sum + l.value, 0),
      lostLeads: lost.length,
      hotLeads: open.filter((l: Doc<"leads">) => l.temperature === "hot").length,
      unassignedLeads: open.filter((l: Doc<"leads">) => !l.assignedTo).length,
      sampled: leads.length === 1000,
    },
  };
}

async function listTeamMembersTool(
  ctx: ReadCtx,
  organizationId: Id<"organizations">
): Promise<Record<string, unknown>> {
  const members = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(200);
  return {
    members: members.map((m: Doc<"teamMembers">) => ({
      id: m._id,
      name: m.name,
      role: m.role,
      type: m.type,
      status: m.status,
    })),
  };
}

async function listBoardsAndStagesTool(
  ctx: ReadCtx,
  organizationId: Id<"organizations">
): Promise<Record<string, unknown>> {
  const boardsWithStages = await loadBoardsWithStages(ctx, organizationId);
  return {
    boards: boardsWithStages.map(({ board, stages }) => ({
      id: board._id,
      name: board.name,
      isDefault: board.isDefault,
      stages: stages.map((s: Doc<"stages">) => ({
        id: s._id,
        name: s.name,
        order: s.order,
        isClosedWon: s.isClosedWon,
        isClosedLost: s.isClosedLost,
      })),
    })),
  };
}

async function listQuickRepliesTool(
  ctx: ReadCtx,
  organizationId: Id<"organizations">
): Promise<Record<string, unknown>> {
  const quickReplies = await ctx.db
    .query("quickReplies")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(100);
  return {
    quickReplies: quickReplies.map((r: Doc<"quickReplies">) => ({
      shortcut: r.shortcut,
      content: r.content,
    })),
  };
}

async function listTasksTool(
  ctx: ReadCtx,
  organizationId: Id<"organizations">,
  toolArgs: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const limit = Math.min(typeof toolArgs.limit === "number" ? toolArgs.limit : 25, 50);
  const status = typeof toolArgs.status === "string" ? toolArgs.status : undefined;

  const tasks = status
    ? await ctx.db
        .query("tasks")
        .withIndex("by_organization_and_status", (q) =>
          q
            .eq("organizationId", organizationId)
            .eq("status", status as Doc<"tasks">["status"])
        )
        .order("desc")
        .take(limit)
    : await ctx.db
        .query("tasks")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .order("desc")
        .take(limit);

  const assigneeMap = await batchGet(ctx.db, tasks.map((t: Doc<"tasks">) => t.assignedTo));
  return {
    tasks: tasks.map((t: Doc<"tasks">) => ({
      id: t._id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate ?? null,
      assignee: t.assignedTo ? assigneeMap.get(t.assignedTo)?.name ?? null : null,
    })),
  };
}

// ── Executor de tools de ESCRITA (F2) ──
// O copiloto age COMO O USUÁRIO: ator = o membro HUMANO da sessão, actorType
// "human" + metadata.via:"copilot" (accountability preservada — v2 §3.5).
// Destrutivo NUNCA executa aqui: vira pendingAction (two-phase server-side)
// que só a mutation confirmPendingAction, disparada por clique humano, executa.

const PENDING_ACTION_TTL_MS = 15 * 60 * 1000;

// ── Campanhas (copiloto lê; rascunha; pausa; cancelar = pendingAction; lançar = humano) ──

const CAMPAIGN_URL = (id: string) => `/app/campanhas?campanha=${id}`;

function campaignSummary(c: Record<string, any>) {
  return {
    campaignId: c._id,
    name: c.name,
    status: c.status,
    provider: c.provider,
    contentKind: c.contentKind ?? c.content?.kind,
    channel: c.channel?.displayName ?? null,
    stats: {
      total: c.stats.total,
      pending: c.stats.pending,
      sent: c.stats.sent + c.stats.delivered + c.stats.read + c.stats.replied,
      delivered: c.stats.delivered + c.stats.read + c.stats.replied,
      read: c.stats.read + c.stats.replied,
      replied: c.stats.replied,
      failed: c.stats.failed,
      skipped: c.stats.skipped,
      optedOut: c.stats.optedOut,
    },
    pausedReason: c.pausedReason ?? null,
    startedAt: c.startedAt ?? null,
    completedAt: c.completedAt ?? null,
    url: CAMPAIGN_URL(c._id),
  };
}

async function listCampaignsTool(
  ctx: ReadCtx,
  organizationId: Id<"organizations">,
  toolArgs: Record<string, unknown>,
  memberId: Id<"teamMembers">
): Promise<Record<string, unknown>> {
  const status = typeof toolArgs.status === "string" ? (toolArgs.status as any) : undefined;
  const rows = (await listCampaignsHandler(ctx, {
    organizationId,
    ...(status ? { status } : {}),
    actorMemberId: memberId,
  })) as Record<string, any>[];
  return { campaigns: rows.slice(0, 50).map(campaignSummary) };
}

async function getCampaignReportTool(
  ctx: ReadCtx,
  organizationId: Id<"organizations">,
  toolArgs: Record<string, unknown>,
  memberId: Id<"teamMembers">
): Promise<Record<string, unknown>> {
  if (typeof toolArgs.campaignId !== "string") return { error: "campaignId é obrigatório" };
  const campaign = await ctx.db.get(toolArgs.campaignId as Id<"campaigns">).catch(() => null);
  if (!campaign || campaign.organizationId !== organizationId) return { error: "Campanha não encontrada" };
  const report = (await getCampaignReportHandler(ctx, {
    campaignId: campaign._id,
    actorMemberId: memberId,
  })) as Record<string, any>;
  return {
    report: {
      campaignId: report.campaignId,
      name: report.name,
      status: report.status,
      provider: report.provider,
      stats: report.stats,
      rates: report.rates,
      progress: report.progress,
      errorBreakdown: report.errorBreakdown,
      skipBreakdown: report.skipBreakdown,
      estimatedCostUsd: report.estimatedCostUsd,
      tierAtLaunch: report.tierAtLaunch,
      pausedReason: report.pausedReason,
      startedAt: report.startedAt,
      completedAt: report.completedAt,
      timeline: (report.timeline ?? []).slice(-10),
      url: CAMPAIGN_URL(report.campaignId),
    },
  };
}

/** Resolve nomes (board/estágios) vindos do modelo para ids DA ORG. */
async function resolveAudienceFilters(
  ctx: ReadCtx | MutationCtx,
  organizationId: Id<"organizations">,
  input: Record<string, unknown>,
  now: number
): Promise<{ filters: Record<string, unknown> } | { error: string }> {
  const filters: Record<string, unknown> = {};
  const boardName = typeof input.boardName === "string" ? input.boardName.trim() : "";
  if (boardName || Array.isArray(input.stageNames)) {
    const boards = (
      await ctx.db
        .query("boards")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect()
    ).filter((b) => b.archivedAt === undefined);
    const board = boardName
      ? boards.find((b) => b.name.toLowerCase() === boardName.toLowerCase())
      : boards.find((b) => b.isDefault) ?? boards[0];
    if (!board) return { error: boardName ? `Board "${boardName}" não existe` : "Nenhum board configurado" };
    filters.boardId = board._id;
    if (Array.isArray(input.stageNames) && input.stageNames.length > 0) {
      const stages = await ctx.db
        .query("stages")
        .withIndex("by_board_and_order", (q) => q.eq("boardId", board._id))
        .collect();
      const ids: Id<"stages">[] = [];
      for (const raw of input.stageNames) {
        if (typeof raw !== "string") continue;
        const stage = stages.find((st) => st.name.toLowerCase() === raw.trim().toLowerCase());
        if (!stage) return { error: `Estágio "${raw}" não existe no board "${board.name}"` };
        ids.push(stage._id);
      }
      filters.stageIds = ids;
    }
  }
  if (Array.isArray(input.tags)) filters.tags = input.tags.filter((t) => typeof t === "string");
  if (typeof input.temperature === "string") filters.temperature = input.temperature;
  if (typeof input.priority === "string") filters.priority = input.priority;
  const DAY = 24 * 60 * 60 * 1000;
  if (typeof input.lastActivityBeforeDays === "number") {
    filters.lastActivityBefore = now - input.lastActivityBeforeDays * DAY;
  }
  if (typeof input.lastActivityAfterDays === "number") {
    filters.lastActivityAfter = now - input.lastActivityAfterDays * DAY;
  }
  if (input.onlyOpenWindow === true) filters.onlyOpenWindow = true;
  if (typeof input.excludeCampaignedWithinDays === "number") {
    filters.excludeCampaignedWithinDays = input.excludeCampaignedWithinDays;
  }
  if (input.excludeRepliedToCampaigns === true) filters.excludeRepliedToCampaigns = true;
  return { filters };
}

function maskPhone(phone: string): string {
  return phone.length > 8 ? `${phone.slice(0, 4)}${"*".repeat(phone.length - 8)}${phone.slice(-4)}` : phone;
}

/**
 * Grupos por NOME (o copiloto fala em nome, não em id). Só grupos monitorados:
 * é o mesmo recorte que o wizard oferece, e um grupo que ninguém acompanha não
 * tem conversa para receber nada.
 */
async function resolveGroupNames(
  ctx: ReadCtx | MutationCtx,
  organizationId: Id<"organizations">,
  names: unknown
): Promise<{ ids: Id<"groupChats">[] } | { error: string }> {
  const list = Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
  if (list.length === 0) return { error: "Informe groupNames (nomes dos grupos monitorados)" };
  const groups = await ctx.db
    .query("groupChats")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(500);
  const monitored = groups.filter((g) => g.monitored && g.removedAt === undefined && g.leftAt === undefined);
  const ids: Id<"groupChats">[] = [];
  for (const raw of list) {
    const needle = raw.trim().toLowerCase();
    const exact = monitored.find((g) => g.subject.toLowerCase() === needle);
    // Sem casamento exato, o parcial só vale quando é ÚNICO: com "Clientes SP"
    // e "Clientes RJ" na org, pedir "grupo Clientes" escolhia o primeiro em
    // silêncio e a campanha ia para a sala errada (achado menor do review).
    const partial = monitored.filter((g) => g.subject.toLowerCase().includes(needle));
    if (!exact && partial.length > 1) {
      return {
        error: `"${raw}" casa com mais de um grupo (${partial
          .map((g) => g.subject)
          .join(", ")}) — use o nome exato`,
      };
    }
    const match = exact ?? partial[0];
    if (!match) {
      return {
        error: `Grupo "${raw}" não encontrado entre os monitorados (${
          monitored.map((g) => g.subject).join(", ") || "nenhum"
        })`,
      };
    }
    ids.push(match._id);
  }
  return { ids };
}

async function resolveMemberFilters(
  ctx: ReadCtx | MutationCtx,
  organizationId: Id<"organizations">,
  input: unknown
): Promise<{ filters: Record<string, unknown> } | { error: string }> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const filters: Record<string, unknown> = {};
  if (raw.excludeAdmins === true) filters.excludeAdmins = true;
  if (raw.excludeExistingContacts === true) filters.excludeExistingContacts = true;
  if (typeof raw.excludeCampaignedWithinDays === "number") {
    filters.excludeCampaignedWithinDays = raw.excludeCampaignedWithinDays;
  }
  if (typeof raw.activeInGroupWithinDays === "number") {
    filters.activeInGroupWithinDays = raw.activeInGroupWithinDays;
  }
  if (Array.isArray(raw.excludeGroupNames) && raw.excludeGroupNames.length > 0) {
    const resolved = await resolveGroupNames(ctx, organizationId, raw.excludeGroupNames);
    if ("error" in resolved) return resolved;
    filters.excludeGroupChatIds = resolved.ids;
  }
  // Seleção explícita de pessoas (chave = `lid ?? phone`, como a lista da
  // prévia devolve). Chave desconhecida é ignorada lá adiante; aqui só o teto
  // vira erro, e ele vira erro de TOOL (texto para a IA), não exceção.
  if (Array.isArray(raw.includeKeys) && raw.includeKeys.length > 0) {
    try {
      const keys = normalizeIncludeKeys(raw.includeKeys.map((k: unknown) => String(k)));
      if (keys) filters.includeKeys = keys;
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { filters };
}

async function previewCampaignAudienceTool(
  ctx: ReadCtx,
  organizationId: Id<"organizations">,
  toolArgs: Record<string, unknown>,
  scope: { memberId: Id<"teamMembers">; now: number }
): Promise<Record<string, unknown>> {
  const source = typeof toolArgs.source === "string" ? toolArgs.source : "segment";
  if (source === "groups" || source === "group_members") {
    const groups = await resolveGroupNames(ctx, organizationId, toolArgs.groupNames);
    if ("error" in groups) return groups;
    const memberFilters = await resolveMemberFilters(ctx, organizationId, toolArgs.memberFilters);
    if ("error" in memberFilters) return memberFilters;
    const preview = (await previewAudienceHandler(ctx, {
      organizationId,
      filters: {},
      now: scope.now,
      source: source as "groups" | "group_members",
      groupChatIds: groups.ids,
      ...(source === "group_members" ? { memberFilters: memberFilters.filters as any } : {}),
      actorMemberId: scope.memberId,
    })) as Record<string, any>;
    return {
      count: preview.count,
      excluded: preview.excluded,
      truncated: preview.truncated,
      funnel: preview.funnel ?? null,
      perGroup: preview.perGroup ?? [],
      estimatedDays: preview.estimatedDays ?? 0,
      ...(preview.reach !== undefined ? { reach: preview.reach } : {}),
      // A amostra de membros JÁ vem mascarada do builder (são terceiros).
      sample: preview.sample ?? [],
    };
  }
  const resolved = await resolveAudienceFilters(ctx, organizationId, toolArgs, scope.now);
  if ("error" in resolved) return resolved;
  const preview = (await previewAudienceHandler(ctx, {
    organizationId,
    filters: resolved.filters as any,
    now: scope.now,
    actorMemberId: scope.memberId,
  })) as Record<string, any>;
  return {
    count: preview.count,
    excluded: preview.excluded,
    truncated: preview.truncated,
    sample: (preview.sample ?? []).map((c: any) => ({
      name: c.displayName ?? null,
      phone: maskPhone(String(c.phone ?? "")),
    })),
  };
}

export const internalRunCopilotWriteTool = internalMutation({
  args: {
    name: v.string(),
    argsJson: v.string(),
    organizationId: v.id("organizations"),
    memberId: v.id("teamMembers"),
    threadId: v.optional(v.id("copilotThreads")),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const spec = toolSpecByName(args.name);
    if (!spec || !COPILOT_WRITE_TOOLS.some((t) => t.name === args.name)) {
      return { error: `Tool de escrita desconhecida: ${args.name}` };
    }
    const member = await assertAgentCan(
      ctx,
      args.memberId,
      spec.permission.category,
      spec.permission.level
    );
    if (member.organizationId !== args.organizationId) {
      throw new Error("Membro não pertence a esta organização");
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(args.argsJson || "{}");
    } catch {
      return { error: "Argumentos inválidos (JSON malformado)" };
    }

    const raw = await runWriteTool(ctx, args.name, parsed, {
      organizationId: args.organizationId,
      member,
      threadId: args.threadId,
    });
    if ("error" in raw) return raw;
    return projectToolResult(spec, raw);
  },
});

type WriteToolCtx = {
  organizationId: Id<"organizations">;
  member: Doc<"teamMembers">;
  threadId?: Id<"copilotThreads">;
};

async function runWriteTool(
  ctx: MutationCtx,
  name: string,
  toolArgs: Record<string, unknown>,
  scope: WriteToolCtx
): Promise<Record<string, unknown>> {
  const now = Date.now();
  const { organizationId, member } = scope;

  // Helper: audit com a marca "via copiloto" (ator humano, instrumento IA).
  const audit = async (entry: {
    entityType: string;
    entityId: string;
    action: "create" | "update" | "delete" | "move" | "assign";
    changes?: { before?: Record<string, unknown>; after?: Record<string, unknown> };
    metadata?: Record<string, unknown>;
    description: string;
    severity: "low" | "medium" | "high";
  }) => {
    await ctx.db.insert("auditLogs", {
      organizationId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      actorId: member._id,
      actorType: "human",
      changes: entry.changes,
      metadata: { ...(entry.metadata ?? {}), via: "copilot" },
      description: `${entry.description} (via Copiloto)`,
      severity: entry.severity,
      createdAt: now,
    });
  };

  const getCampaignInOrgForCopilot = async (idRaw: unknown): Promise<Doc<"campaigns"> | null> => {
    if (typeof idRaw !== "string") return null;
    const campaign = await ctx.db.get(idRaw as Id<"campaigns">).catch(() => null);
    if (!campaign || campaign.organizationId !== organizationId) return null;
    return campaign;
  };

  // Resolve um lead validando a org (id vem do modelo — camada 1 de novo aqui).
  const getLeadInOrg = async (leadIdRaw: unknown): Promise<Doc<"leads"> | null> => {
    if (typeof leadIdRaw !== "string") return null;
    const lead = await ctx.db.get(leadIdRaw as Id<"leads">).catch(() => null);
    if (!lead || lead.organizationId !== organizationId) return null;
    return lead;
  };

  switch (name) {
    case "createLead": {
      const title = typeof toolArgs.title === "string" ? toolArgs.title.trim() : "";
      if (!title) return { error: "title é obrigatório" };

      const boards = (
        await ctx.db
          .query("boards")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
          .collect()
      ).filter((b) => b.archivedAt === undefined);
      const boardName = typeof toolArgs.boardName === "string" ? toolArgs.boardName : undefined;
      const board = boardName
        ? boards.find((b) => b.name.toLowerCase() === boardName.toLowerCase())
        : boards.find((b) => b.isDefault) ?? boards[0];
      if (!board) return { error: boardName ? `Board "${boardName}" não existe` : "Nenhum board configurado" };

      const stages = await ctx.db
        .query("stages")
        .withIndex("by_board_and_order", (q) => q.eq("boardId", board._id))
        .collect();
      const stageName = typeof toolArgs.stageName === "string" ? toolArgs.stageName : undefined;
      const stage = stageName
        ? stages.find((s) => s.name.toLowerCase() === stageName.toLowerCase())
        : stages[0];
      if (!stage) return { error: stageName ? `Estágio "${stageName}" não existe` : "Board sem estágios" };

      let contactId: Id<"contacts"> | undefined;
      if (typeof toolArgs.contactId === "string") {
        const contact = await ctx.db.get(toolArgs.contactId as Id<"contacts">).catch(() => null);
        if (!contact || contact.organizationId !== organizationId) {
          return { error: "Contato não encontrado" };
        }
        contactId = contact._id;
      }

      const org = await ctx.db.get(organizationId);
      const leadId = await ctx.db.insert("leads", {
        organizationId,
        title,
        contactId,
        boardId: board._id,
        stageId: stage._id,
        value: typeof toolArgs.value === "number" ? toolArgs.value : 0,
        currency: org?.settings.currency ?? "BRL",
        priority: (toolArgs.priority as Doc<"leads">["priority"]) ?? "medium",
        temperature: (toolArgs.temperature as Doc<"leads">["temperature"]) ?? "cold",
        tags: Array.isArray(toolArgs.tags)
          ? (toolArgs.tags.filter((t) => typeof t === "string") as string[])
          : [],
        customFields: {},
        conversationStatus: "new",
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await audit({
        entityType: "lead",
        entityId: leadId,
        action: "create",
        metadata: { title },
        description: `Criou o lead '${title}'`,
        severity: "medium",
      });
      await ctx.db.insert("activities", {
        organizationId,
        leadId,
        type: "created",
        actorId: member._id,
        actorType: "human",
        content: `Lead "${title}" criado via Copiloto`,
        metadata: { via: "copilot" },
        createdAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
        organizationId,
        event: "lead.created",
        payload: { leadId, title, boardId: board._id, stageId: stage._id },
      });
      return { status: "criado", leadId, title };
    }

    case "updateLead": {
      const lead = await getLeadInOrg(toolArgs.leadId);
      if (!lead) return { error: "Lead não encontrado" };

      const changes: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      if (typeof toolArgs.title === "string" && toolArgs.title !== lead.title) {
        changes.title = toolArgs.title;
        before.title = lead.title;
      }
      if (typeof toolArgs.value === "number" && toolArgs.value !== lead.value) {
        changes.value = toolArgs.value;
        before.value = lead.value;
      }
      if (typeof toolArgs.priority === "string" && toolArgs.priority !== lead.priority) {
        changes.priority = toolArgs.priority;
        before.priority = lead.priority;
      }
      if (typeof toolArgs.temperature === "string" && toolArgs.temperature !== lead.temperature) {
        changes.temperature = toolArgs.temperature;
        before.temperature = lead.temperature;
      }
      if (Array.isArray(toolArgs.tags)) {
        changes.tags = toolArgs.tags.filter((t) => typeof t === "string");
        before.tags = lead.tags;
      }
      if (Object.keys(changes).length === 0) return { status: "sem_mudancas", leadId: lead._id };

      await ctx.db.patch(lead._id, { ...changes, lastActivityAt: now, updatedAt: now });
      await audit({
        entityType: "lead",
        entityId: lead._id,
        action: "update",
        changes: { before, after: changes },
        metadata: { title: lead.title },
        description: `Atualizou o lead '${lead.title}'`,
        severity: "low",
      });
      await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
        organizationId,
        event: "lead.updated",
        payload: { leadId: lead._id, changes },
      });
      return { status: "atualizado", leadId: lead._id };
    }

    case "moveLead": {
      const lead = await getLeadInOrg(toolArgs.leadId);
      if (!lead) return { error: "Lead não encontrado" };
      const stageName = typeof toolArgs.stageName === "string" ? toolArgs.stageName : "";
      const stages = await ctx.db
        .query("stages")
        .withIndex("by_board_and_order", (q) => q.eq("boardId", lead.boardId))
        .collect();
      const target = stages.find((s) => s.name.toLowerCase() === stageName.toLowerCase().trim());
      if (!target) return { error: `Estágio "${stageName}" não existe no funil deste lead` };
      if (target._id === lead.stageId) {
        return { status: "ja_estava", leadId: lead._id, stageName: target.name };
      }

      const oldStage = stages.find((s) => s._id === lead.stageId);
      const patch: Record<string, unknown> = {
        stageId: target._id,
        lastActivityAt: now,
        updatedAt: now,
      };
      if (target.isClosedWon) {
        patch.closedAt = now;
        patch.closedType = "won";
      } else if (target.isClosedLost) {
        patch.closedAt = now;
        patch.closedType = "lost";
      } else {
        patch.closedAt = undefined;
        patch.closedReason = undefined;
        patch.closedType = undefined;
      }
      await ctx.db.patch(lead._id, patch);
      await audit({
        entityType: "lead",
        entityId: lead._id,
        action: "move",
        changes: { before: { stageId: lead.stageId }, after: { stageId: target._id } },
        metadata: { title: lead.title, fromStageName: oldStage?.name, toStageName: target.name },
        description: `Moveu o lead '${lead.title}' de '${oldStage?.name}' para '${target.name}'`,
        severity: "medium",
      });
      await ctx.db.insert("activities", {
        organizationId,
        leadId: lead._id,
        type: "stage_change",
        actorId: member._id,
        actorType: "human",
        content: `Movido de "${oldStage?.name ?? "?"}" para "${target.name}" via Copiloto`,
        metadata: { oldStageId: lead.stageId, newStageId: target._id, via: "copilot" },
        createdAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
        organizationId,
        event: "lead.stage_changed",
        payload: { leadId: lead._id, oldStageId: lead.stageId, newStageId: target._id },
      });
      return { status: "movido", leadId: lead._id, stageName: target.name };
    }

    case "assignLead": {
      const lead = await getLeadInOrg(toolArgs.leadId);
      if (!lead) return { error: "Lead não encontrado" };
      const memberName = typeof toolArgs.memberName === "string" ? toolArgs.memberName.trim() : "";
      const members = await ctx.db
        .query("teamMembers")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect();
      const target = members.find(
        (m) => m.status === "active" && m.name.toLowerCase().includes(memberName.toLowerCase())
      );
      if (!target) return { error: `Membro "${memberName}" não encontrado` };
      if (lead.assignedTo === target._id) {
        return { status: "ja_atribuido", leadId: lead._id, memberName: target.name };
      }

      await ctx.db.patch(lead._id, { assignedTo: target._id, lastActivityAt: now, updatedAt: now });
      await audit({
        entityType: "lead",
        entityId: lead._id,
        action: "assign",
        changes: { before: { assignedTo: lead.assignedTo }, after: { assignedTo: target._id } },
        metadata: { title: lead.title, assigneeName: target.name },
        description: `Atribuiu o lead '${lead.title}' a ${target.name}`,
        severity: "medium",
      });
      await ctx.db.insert("activities", {
        organizationId,
        leadId: lead._id,
        type: "assignment",
        actorId: member._id,
        actorType: "human",
        content: `Atribuído a ${target.name} via Copiloto`,
        metadata: { via: "copilot" },
        createdAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
        organizationId,
        event: "lead.assigned",
        payload: { leadId: lead._id, oldAssignedTo: lead.assignedTo, newAssignedTo: target._id },
      });
      if (target.type === "human") {
        await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
          organizationId,
          recipientMemberId: target._id,
          eventType: "leadAssigned",
          templateData: {
            leadTitle: lead.title,
            assignedByName: member.name,
            leadUrl: `${process.env.APP_URL ?? "https://app.hnbcrm.com.br"}/app/pipeline`,
          },
        });
      }
      return { status: "atribuido", leadId: lead._id, memberName: target.name };
    }

    case "createContact": {
      const firstName = typeof toolArgs.firstName === "string" ? toolArgs.firstName : undefined;
      const email = typeof toolArgs.email === "string" ? toolArgs.email : undefined;
      const phone = typeof toolArgs.phone === "string" ? toolArgs.phone : undefined;
      if (!firstName && !email && !phone) {
        return { error: "Informe ao menos nome, e-mail ou telefone" };
      }
      const fields = {
        firstName,
        lastName: typeof toolArgs.lastName === "string" ? toolArgs.lastName : undefined,
        email,
        phone,
        company: typeof toolArgs.company === "string" ? toolArgs.company : undefined,
      };
      const contactId = await ctx.db.insert("contacts", {
        organizationId,
        ...fields,
        tags: [],
        searchText: buildSearchText(fields) || undefined,
        createdAt: now,
        updatedAt: now,
      });
      await audit({
        entityType: "contact",
        entityId: contactId,
        action: "create",
        metadata: { name: `${firstName ?? ""}`.trim(), email },
        description: `Criou o contato '${firstName ?? email ?? phone}'`,
        severity: "low",
      });
      return { status: "criado", contactId };
    }

    case "createTask": {
      const title = typeof toolArgs.title === "string" ? toolArgs.title.trim() : "";
      if (!title) return { error: "title é obrigatório" };
      let leadId: Id<"leads"> | undefined;
      if (toolArgs.leadId !== undefined) {
        const lead = await getLeadInOrg(toolArgs.leadId);
        if (!lead) return { error: "Lead não encontrado" };
        leadId = lead._id;
      }
      const dueInHours =
        typeof toolArgs.dueInHours === "number" && toolArgs.dueInHours > 0
          ? Math.min(toolArgs.dueInHours, 24 * 90)
          : undefined;
      const taskId = await ctx.db.insert("tasks", {
        organizationId,
        title: title.slice(0, 160),
        type: "task",
        status: "pending",
        priority: (toolArgs.priority as Doc<"tasks">["priority"]) ?? "medium",
        dueDate: dueInHours ? now + dueInHours * 60 * 60 * 1000 : undefined,
        leadId,
        assignedTo: member._id,
        createdBy: member._id,
        searchText: title.toLowerCase(),
        createdAt: now,
        updatedAt: now,
      });
      if (leadId) {
        await ctx.db.insert("activities", {
          organizationId,
          leadId,
          type: "task_created",
          actorId: member._id,
          actorType: "human",
          content: `Tarefa criada via Copiloto: ${title}`,
          metadata: { taskId, via: "copilot" },
          createdAt: now,
        });
      }
      return { status: "criada", taskId };
    }

    case "createBoard": {
      const boardName = typeof toolArgs.name === "string" ? toolArgs.name.trim() : "";
      const stagesArg = Array.isArray(toolArgs.stages) ? toolArgs.stages : [];
      if (!boardName || stagesArg.length === 0) {
        return { error: "name e stages são obrigatórios" };
      }
      if (stagesArg.length > 12) return { error: "Máximo de 12 estágios por board" };

      const boards = await ctx.db
        .query("boards")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect();
      if (boards.some((b) => b.name.toLowerCase() === boardName.toLowerCase())) {
        return { error: `Board "${boardName}" já existe` };
      }

      const boardId = await ctx.db.insert("boards", {
        organizationId,
        name: boardName,
        color: "#6366F1",
        isDefault: boards.length === 0,
        order: boards.length,
        createdAt: now,
        updatedAt: now,
      });
      const palette = ["#EF4444", "#F59E0B", "#8B5CF6", "#06B6D4", "#10B981", "#6B7280"];
      let order = 0;
      for (const rawStage of stagesArg) {
        const s = rawStage as { name?: unknown; isClosedWon?: unknown; isClosedLost?: unknown };
        const stageName = typeof s.name === "string" ? s.name.trim() : "";
        if (!stageName) continue;
        await ctx.db.insert("stages", {
          organizationId,
          boardId,
          name: stageName,
          color: palette[order % palette.length],
          order,
          isClosedWon: s.isClosedWon === true,
          isClosedLost: s.isClosedLost === true,
          createdAt: now,
          updatedAt: now,
        });
        order++;
      }
      await audit({
        entityType: "board",
        entityId: boardId,
        action: "create",
        metadata: { name: boardName, stageCount: order },
        description: `Criou o board '${boardName}' com ${order} estágios`,
        severity: "medium",
      });
      return { status: "criado", boardId, stageCount: order };
    }

    case "createFieldDefinition": {
      const fieldName = typeof toolArgs.name === "string" ? toolArgs.name.trim() : "";
      const key = typeof toolArgs.key === "string" ? toolArgs.key.trim() : "";
      const fieldType = typeof toolArgs.fieldType === "string" ? toolArgs.fieldType : "";
      const entityType = toolArgs.entityType === "contact" ? "contact" : "lead";
      if (!fieldName || !key || !fieldType) {
        return { error: "name, key e fieldType são obrigatórios" };
      }
      const existing = await ctx.db
        .query("fieldDefinitions")
        .withIndex("by_organization_and_key", (q) =>
          q.eq("organizationId", organizationId).eq("key", key)
        )
        .first();
      if (existing) return { error: `Campo com a chave "${key}" já existe` };

      const count = (
        await ctx.db
          .query("fieldDefinitions")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
          .collect()
      ).length;
      const fieldDefinitionId = await ctx.db.insert("fieldDefinitions", {
        organizationId,
        name: fieldName,
        key,
        type: fieldType as Doc<"fieldDefinitions">["type"],
        entityType,
        options: Array.isArray(toolArgs.options)
          ? (toolArgs.options.filter((o) => typeof o === "string") as string[])
          : undefined,
        isRequired: false,
        order: count,
        createdAt: now,
      });
      await audit({
        entityType: "fieldDefinition",
        entityId: fieldDefinitionId,
        action: "create",
        metadata: { name: fieldName, key, entityType },
        description: `Criou o campo personalizado '${fieldName}'`,
        severity: "low",
      });
      return { status: "criado", fieldDefinitionId };
    }

    case "createQuickReply": {
      const shortcut = typeof toolArgs.shortcut === "string"
        ? toolArgs.shortcut.trim().replace(/^\//, "")
        : "";
      const content = typeof toolArgs.content === "string" ? toolArgs.content.trim() : "";
      if (!shortcut || !content) return { error: "shortcut e content são obrigatórios" };
      const existing = await ctx.db
        .query("quickReplies")
        .withIndex("by_organization_and_shortcut", (q) =>
          q.eq("organizationId", organizationId).eq("shortcut", shortcut)
        )
        .first();
      if (existing) return { error: `Resposta rápida "/${shortcut}" já existe` };
      const quickReplyId = await ctx.db.insert("quickReplies", {
        organizationId,
        shortcut,
        content,
        createdBy: member._id,
        createdAt: now,
        updatedAt: now,
      });
      return { status: "criada", quickReplyId };
    }

    case "createCampaignDraft": {
      const name = typeof toolArgs.name === "string" ? toolArgs.name.trim() : "";
      if (!name) return { error: "name é obrigatório" };
      const variants = Array.isArray(toolArgs.variants)
        ? toolArgs.variants.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        : [];
      if (variants.length === 0) return { error: "Informe ao menos uma variante de texto" };
      const audienceIn = (toolArgs.audience ?? {}) as Record<string, unknown>;
      const kind =
        audienceIn.kind === "segment" ||
        audienceIn.kind === "groups" ||
        audienceIn.kind === "group_members"
          ? (audienceIn.kind as "segment" | "groups" | "group_members")
          : "manual";

      // Canal: pelo nome, ou o único WhatsApp ativo da org.
      const channels = (
        await ctx.db
          .query("channelConfigs")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
          .collect()
      ).filter((c) => c.channel === "whatsapp" && c.status === "active");
      const channelName = typeof toolArgs.channelName === "string" ? toolArgs.channelName.trim() : "";
      const channel = channelName
        ? channels.find((c) => c.displayName.toLowerCase() === channelName.toLowerCase())
        : channels.length === 1
          ? channels[0]
          : undefined;
      if (!channel) {
        return {
          error:
            channels.length === 0
              ? "Nenhum canal WhatsApp ativo — conecte um em Configurações → Canais"
              : `Informe channelName (canais ativos: ${channels.map((c) => c.displayName).join(", ")})`,
        };
      }

      let filters: Record<string, unknown> | undefined;
      let groupChatIds: Id<"groupChats">[] | undefined;
      let memberFilters: Record<string, unknown> | undefined;
      if (kind === "segment") {
        const resolved = await resolveAudienceFilters(ctx, organizationId, audienceIn, now);
        if ("error" in resolved) return resolved;
        filters = resolved.filters;
      } else if (kind === "groups" || kind === "group_members") {
        const resolved = await resolveGroupNames(ctx, organizationId, audienceIn.groupNames);
        if ("error" in resolved) return resolved;
        groupChatIds = resolved.ids;
        if (kind === "group_members") {
          const mf = await resolveMemberFilters(ctx, organizationId, audienceIn.memberFilters);
          if ("error" in mf) return mf;
          memberFilters = mf.filters;
        }
      }
      let targetBoardId: Id<"boards"> | undefined;
      let targetStageId: Id<"stages"> | undefined;
      if (typeof toolArgs.targetBoardName === "string" && toolArgs.targetBoardName.trim()) {
        const resolved = await resolveAudienceFilters(
          ctx,
          organizationId,
          {
            boardName: toolArgs.targetBoardName,
            ...(typeof toolArgs.targetStageName === "string" ? { stageNames: [toolArgs.targetStageName] } : {}),
          },
          now
        );
        if ("error" in resolved) return resolved;
        targetBoardId = resolved.filters.boardId as Id<"boards">;
        targetStageId = (resolved.filters.stageIds as Id<"stages">[] | undefined)?.[0];
      }

      const campaignId = await createCampaignHandler(ctx, {
        organizationId,
        name,
        description: typeof toolArgs.description === "string" ? toolArgs.description : undefined,
        channelConfigId: channel._id,
        content: {
          kind: "text",
          variants: variants.map((text) => ({ text })),
          contentType: "text",
        },
        audience: {
          source: kind,
          ...(filters ? { filters: filters as any } : {}),
          ...(groupChatIds ? { groupChatIds } : {}),
          ...(memberFilters && Object.keys(memberFilters).length > 0
            ? { memberFilters: memberFilters as any }
            : {}),
          ...(targetBoardId ? { targetBoardId } : {}),
          ...(targetStageId ? { targetStageId } : {}),
        },
        actorMemberId: member._id,
        via: "copilot",
      });

      let recipientsAdded = 0;
      let invalid: Array<{ phone: string; reason: string }> = [];
      if (kind === "manual" && Array.isArray(audienceIn.phones) && audienceIn.phones.length > 0) {
        const phones = audienceIn.phones.filter((p): p is string => typeof p === "string").slice(0, 500);
        const added = await addManualRecipientsHandler(ctx, {
          campaignId,
          entries: phones.map((phone) => ({ phone })),
          actorMemberId: member._id,
        });
        recipientsAdded = added.added;
        invalid = added.invalid;
      }
      const provider = configProvider(channel);
      return {
        status: "rascunho_criado",
        campaignId,
        name,
        recipientsAdded,
        invalid,
        url: CAMPAIGN_URL(campaignId),
        next: `Rascunho salvo no canal "${channel.displayName}" (${provider}). O lançamento é feito por um humano na tela de Campanhas, onde ficam os aceites obrigatórios${provider === "bridge" ? " (inclusive o risco de banimento do bridge)" : ""}${kind === "group_members" ? " e o aceite de mandar mensagem privada a quem não iniciou conversa" : ""}.`,
      };
    }

    case "pauseCampaign": {
      const campaign = await getCampaignInOrgForCopilot(toolArgs.campaignId);
      if (!campaign) return { error: "Campanha não encontrada" };
      await pauseCampaignHandler(ctx, {
        campaignId: campaign._id,
        reason: typeof toolArgs.reason === "string" ? toolArgs.reason : "Pausada via Copiloto",
        actorMemberId: member._id,
        via: "copilot",
      });
      return { status: "pausada", campaignId: campaign._id };
    }

    case "resumeCampaign": {
      const campaign = await getCampaignInOrgForCopilot(toolArgs.campaignId);
      if (!campaign) return { error: "Campanha não encontrada" };
      await resumeCampaignHandler(ctx, { campaignId: campaign._id, actorMemberId: member._id, via: "copilot" });
      return { status: "retomada", campaignId: campaign._id };
    }

    case "launchCampaign": {
      // DECISÃO: lançar exige aceites (consentimento LGPD + risco do bridge)
      // que o fluxo de pendingActions não transporta — e a UI de confirmação
      // não pergunta nada além de "confirmar". Então o copiloto NÃO lança nem
      // cria pendingAction: devolve a instrução para o humano lançar na tela.
      const campaign = await getCampaignInOrgForCopilot(toolArgs.campaignId);
      if (!campaign) return { error: "Campanha não encontrada" };
      return {
        status: "requer_lancamento_humano",
        campaignId: campaign._id,
        url: CAMPAIGN_URL(campaign._id),
        instruction:
          campaign.status === "draft"
            ? `Abra a campanha «${campaign.name}» em Campanhas, revise público, mensagem e limites, marque os aceites (consentimento/base legal${campaign.provider === "bridge" ? " e risco do bridge — e, se o número for recém-conectado, o risco de número novo" : ""}) e clique em Lançar. O copiloto não pode lançar campanhas.`
            : `A campanha «${campaign.name}» está em "${campaign.status}" — só rascunhos podem ser lançados.`,
      };
    }

    case "cancelCampaign": {
      // TWO-PHASE: grava a proposta; o cancelamento real é confirmPendingAction.
      const campaign = await getCampaignInOrgForCopilot(toolArgs.campaignId);
      if (!campaign) return { error: "Campanha não encontrada" };
      if (!["running", "paused", "scheduled"].includes(campaign.status)) {
        return { error: `A campanha está em "${campaign.status}" e não pode ser cancelada` };
      }
      const preview = `Cancelar a campanha «${campaign.name}» — ${campaign.stats.pending} destinatário(s) pendente(s) deixam de receber a mensagem (não pode ser desfeito)`;
      const pendingActionId = await ctx.db.insert("pendingActions", {
        organizationId,
        requestedBy: member._id,
        threadId: scope.threadId,
        tool: "cancelCampaign",
        args: { campaignId: campaign._id },
        preview,
        status: "pending",
        expiresAt: now + PENDING_ACTION_TTL_MS,
        createdAt: now,
      });
      return { status: "confirmacao_necessaria", pendingActionId, preview };
    }

    case "deleteLead": {
      // TWO-PHASE: nunca executa aqui. Grava a proposta com TTL; a exclusão
      // real é confirmPendingAction, disparada por clique humano.
      const lead = await getLeadInOrg(toolArgs.leadId);
      if (!lead) return { error: "Lead não encontrado" };
      const preview = `Excluir permanentemente o lead "${lead.title}" (esta ação não pode ser desfeita)`;
      const pendingActionId = await ctx.db.insert("pendingActions", {
        organizationId,
        requestedBy: member._id,
        threadId: scope.threadId,
        tool: "deleteLead",
        args: { leadId: lead._id },
        preview,
        status: "pending",
        expiresAt: now + PENDING_ACTION_TTL_MS,
        createdAt: now,
      });
      return { status: "confirmacao_necessaria", pendingActionId, preview };
    }

    default:
      // Grupos de WhatsApp (F4) — executores em `lib/groupCopilotTools.ts`.
      if (isGroupWriteTool(name)) {
        return await runGroupWriteTool(ctx, name, toolArgs, {
          organizationId,
          member,
          threadId: scope.threadId,
          pendingActionTtlMs: PENDING_ACTION_TTL_MS,
        });
      }
      return { error: `Tool não implementada: ${name}` };
  }
}

// ── Ações pendentes (confirmação destrutiva two-phase) ──

export const listPendingActions = query({
  args: { organizationId: v.id("organizations") },
  returns: v.array(
    v.object({
      _id: v.id("pendingActions"),
      tool: v.string(),
      preview: v.string(),
      expiresAt: v.number(),
      createdAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const pending = await ctx.db
      .query("pendingActions")
      .withIndex("by_organization_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("status", "pending")
      )
      .collect();
    // Só quem pediu confirma/vê — e expiradas ficam de fora (o cron não é
    // necessário: a leitura filtra e a confirmação re-checa o TTL).
    return pending
      .filter((p) => p.requestedBy === member._id)
      .map((p) => ({
        _id: p._id,
        tool: p.tool,
        preview: p.preview,
        expiresAt: p.expiresAt,
        createdAt: p.createdAt,
      }));
  },
});

export const confirmPendingAction = mutation({
  args: { pendingActionId: v.id("pendingActions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const pending = await ctx.db.get(args.pendingActionId);
    if (!pending) throw new Error("Ação não encontrada");
    const member = await requireAuth(ctx, pending.organizationId);
    // Só o humano que comandou o copiloto confirma a própria proposta.
    if (pending.requestedBy !== member._id) {
      throw new Error("Apenas quem solicitou pode confirmar esta ação");
    }
    if (pending.status !== "pending") throw new Error("Ação já resolvida");
    const now = Date.now();
    if (pending.expiresAt < now) {
      await ctx.db.patch(pending._id, { status: "expired" });
      throw new Error("Confirmação expirou — peça ao copiloto novamente");
    }

    switch (pending.tool) {
      case "deleteLead": {
        const leadId = pending.args.leadId as Id<"leads">;
        const lead = await ctx.db.get(leadId);
        if (!lead || lead.organizationId !== pending.organizationId) {
          throw new Error("Lead não existe mais");
        }
        // Re-checa a permissão NO MOMENTO da confirmação (pode ter mudado).
        await assertAgentCan(ctx, member._id, "leads", "full", lead);

        await hardDeleteLead(ctx, {
          lead,
          actorId: member._id,
          actorType: "human",
          description: `Excluiu o lead '${lead.title}' (proposto via Copiloto, confirmado)`,
          extraMetadata: { via: "copilot", confirmedAt: now },
        });
        await scheduleLeadCascade(ctx, {
          organizationId: lead.organizationId,
          leadIds: [leadId],
          contactIds: [],
        });
        break;
      }
      case "cancelCampaign": {
        const campaignId = pending.args.campaignId as Id<"campaigns">;
        const campaign = await ctx.db.get(campaignId);
        if (!campaign || campaign.organizationId !== pending.organizationId) {
          throw new Error("Campanha não existe mais");
        }
        // Re-checa a permissão NO MOMENTO da confirmação (campaigns:full).
        await assertAgentCan(ctx, member._id, "campaigns", "full", campaign);
        await cancelCampaignHandler(ctx, { campaignId, actorMemberId: member._id, via: "copilot" });
        break;
      }
      default: {
        // Grupos (F4): publicar num grupo exige `inbox:reply`; ativar uma
        // publicação exige `campaigns:full` — re-checados AGORA, não na
        // proposta (o papel do usuário pode ter mudado no meio).
        if (isGroupPendingTool(pending.tool)) {
          if (pending.tool === "sendGroupMessage") {
            await assertAgentCan(ctx, member._id, "inbox", "reply");
          } else {
            await assertAgentCan(ctx, member._id, "campaigns", "full");
          }
          await confirmGroupPendingAction(ctx, pending, member);
          break;
        }
        throw new Error(`Ação desconhecida: ${pending.tool}`);
      }
    }

    await ctx.db.patch(pending._id, { status: "executed", executedAt: now });
    return null;
  },
});

export const cancelPendingAction = mutation({
  args: { pendingActionId: v.id("pendingActions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const pending = await ctx.db.get(args.pendingActionId);
    if (!pending) return null;
    const member = await requireAuth(ctx, pending.organizationId);
    if (pending.requestedBy !== member._id) {
      throw new Error("Apenas quem solicitou pode cancelar esta ação");
    }
    if (pending.status === "pending") {
      await ctx.db.patch(pending._id, { status: "canceled" });
    }
    return null;
  },
});
