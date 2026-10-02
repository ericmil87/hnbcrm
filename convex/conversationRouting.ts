/**
 * Roteamento de conversa do MVP "Central": setor, responsável, unidade, tipo
 * de contato, desfecho (Convertido / Não convertido) e as filas do inbox.
 *
 * Gates de módulo (org sem o módulo = recusa com "Módulo não habilitado"):
 *  - transferir / atribuir → `departments`
 *  - unidade → `units`
 *  - tipo de contato / desfecho → qualquer módulo da Central ligado
 * As QUERIES não lançam com módulo desligado: devolvem vazio/null, para a UI
 * nunca cair por consultar antes de saber os módulos.
 *
 * "Convertido/Não convertido" REUSA o fechamento de lead existente
 * (`lib/leadStageMove.moveLeadToStageCore`, o mesmo do Kanban).
 */
import { v, ConvexError } from "convex/values";
import { query, mutation, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requirePermission, assertAssignableMember } from "./lib/auth";
import { assertAnyModule, assertModule, getModules } from "./lib/orgModules";
import { createNotification } from "./lib/notify";
import { getLeadRef } from "./lib/leadRef";
import { moveLeadToStageCore } from "./lib/leadStageMove";
import { transferConversationCore } from "./lib/conversationTransfer";
import { departmentConversationCounts, DEPARTMENT_OPEN_COUNT_CAP } from "./departments";
import { contactKindValidator, leadAttributionValidator } from "./schema";

// Varredura das filas "Minhas"/"Sem responsável": as N conversas com
// atividade mais recente (teto documentado — a UI mostra "500+").
export const INBOX_QUEUE_SCAN_CAP = 500;
const TRANSFER_HISTORY_CAP = 50;
const NOTE_MAX_CHARS = 1000;

async function loadConversation(ctx: MutationCtx, conversationId: Id<"conversations">) {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation) throw new Error("Conversa não encontrada");
  return conversation;
}

async function assertDepartmentInOrg(
  ctx: { db: MutationCtx["db"] },
  organizationId: Id<"organizations">,
  departmentId: Id<"departments">
): Promise<Doc<"departments">> {
  const dept = await ctx.db.get(departmentId);
  if (!dept || dept.organizationId !== organizationId) {
    throw new ConvexError("Setor não encontrado nesta organização");
  }
  return dept;
}

async function assertUnitInOrg(
  ctx: { db: MutationCtx["db"] },
  organizationId: Id<"organizations">,
  unitId: Id<"units">
): Promise<Doc<"units">> {
  const unit = await ctx.db.get(unitId);
  if (!unit || unit.organizationId !== organizationId) {
    throw new ConvexError("Unidade não encontrada nesta organização");
  }
  return unit;
}

async function logLeadActivity(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  args: {
    actor: Doc<"teamMembers">;
    type: "assignment" | "note";
    content: string;
    metadata: Record<string, unknown>;
    now: number;
  }
) {
  if (!conversation.leadId) return;
  await ctx.db.insert("activities", {
    organizationId: conversation.organizationId,
    leadId: conversation.leadId,
    type: args.type,
    actorId: args.actor._id,
    actorType: args.actor.type === "ai" ? "ai" : "human",
    content: args.content,
    metadata: { conversationId: conversation._id, ...args.metadata },
    createdAt: args.now,
  });
}

// ─── Transferir ──────────────────────────────────────────────────────────────

export const transferConversation = mutation({
  args: {
    conversationId: v.id("conversations"),
    toDepartmentId: v.optional(v.id("departments")),
    toMemberId: v.optional(v.id("teamMembers")),
    note: v.optional(v.string()),
  },
  returns: v.id("conversationTransfers"),
  handler: async (ctx, args) => {
    const conversation = await loadConversation(ctx, args.conversationId);
    const orgId = conversation.organizationId;
    const actor = await requirePermission(ctx, orgId, "inbox", "reply");
    await assertModule(ctx, orgId, "departments");
    if (!args.toDepartmentId && !args.toMemberId) {
      throw new ConvexError("Informe o setor e/ou a pessoa de destino");
    }

    const toDept = args.toDepartmentId
      ? await assertDepartmentInOrg(ctx, orgId, args.toDepartmentId)
      : null;
    const toMember = args.toMemberId
      ? await assertAssignableMember(ctx, orgId, args.toMemberId)
      : null;
    const note = args.note?.trim().slice(0, NOTE_MAX_CHARS) || undefined;
    return await transferConversationCore(ctx, {
      conversation,
      toDept,
      toMember,
      actor,
      note,
      now: Date.now(),
    });
  },
});

// ─── Responsável / unidade / tipo de contato ────────────────────────────────

export const assignConversation = mutation({
  args: {
    conversationId: v.id("conversations"),
    memberId: v.union(v.id("teamMembers"), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await loadConversation(ctx, args.conversationId);
    const orgId = conversation.organizationId;
    const actor = await requirePermission(ctx, orgId, "inbox", "reply");
    await assertModule(ctx, orgId, "departments");
    const member = args.memberId ? await assertAssignableMember(ctx, orgId, args.memberId) : null;
    if ((conversation.assignedTo ?? null) === (member?._id ?? null)) return null;

    const now = Date.now();
    await ctx.db.patch(conversation._id, { assignedTo: member?._id, updatedAt: now });
    if (member && member._id !== actor._id) {
      await createNotification(ctx, {
        organizationId: orgId,
        memberId: member._id,
        type: "conversation_transferred",
        title: `${actor.name} atribuiu uma conversa a você`,
        body: (await getLeadRef(ctx.db, conversation.leadId))?.title,
        conversationId: conversation._id,
        actorId: actor._id,
      });
    }
    await logLeadActivity(ctx, conversation, {
      actor,
      type: "assignment",
      content: member ? `Conversa atribuída a ${member.name}` : "Conversa sem responsável",
      metadata: { assignedTo: member?._id },
      now,
    });
    await ctx.db.insert("auditLogs", {
      organizationId: orgId,
      entityType: "conversation",
      entityId: conversation._id,
      action: "assign",
      actorId: actor._id,
      actorType: "human",
      changes: { before: { assignedTo: conversation.assignedTo }, after: { assignedTo: member?._id } },
      description: member ? `Atribuiu a conversa a ${member.name}` : "Removeu o responsável da conversa",
      severity: "low",
      createdAt: now,
    });
    return null;
  },
});

export const setConversationUnit = mutation({
  args: {
    conversationId: v.id("conversations"),
    unitId: v.union(v.id("units"), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await loadConversation(ctx, args.conversationId);
    const orgId = conversation.organizationId;
    const actor = await requirePermission(ctx, orgId, "inbox", "reply");
    await assertModule(ctx, orgId, "units");
    const unit = args.unitId ? await assertUnitInOrg(ctx, orgId, args.unitId) : null;

    const now = Date.now();
    await ctx.db.patch(conversation._id, { unitId: unit?._id, updatedAt: now });
    // Espelha no lead: o painel agrupa venda por unidade a partir do lead.
    const lead = await getLeadRef(ctx.db, conversation.leadId);
    if (lead && lead.unitId !== unit?._id) {
      await ctx.db.patch(lead._id, { unitId: unit?._id, updatedAt: now });
    }
    await logLeadActivity(ctx, conversation, {
      actor,
      type: "note",
      content: unit ? `Unidade definida: ${unit.name}` : "Unidade removida",
      metadata: { unitId: unit?._id },
      now,
    });
    await ctx.db.insert("auditLogs", {
      organizationId: orgId,
      entityType: "conversation",
      entityId: conversation._id,
      action: "update",
      actorId: actor._id,
      actorType: "human",
      changes: { before: { unitId: conversation.unitId }, after: { unitId: unit?._id } },
      description: unit ? `Definiu a unidade "${unit.name}" na conversa` : "Removeu a unidade da conversa",
      severity: "low",
      createdAt: now,
    });
    return null;
  },
});

export const setConversationKind = mutation({
  args: {
    conversationId: v.id("conversations"),
    contactKind: contactKindValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await loadConversation(ctx, args.conversationId);
    const orgId = conversation.organizationId;
    const actor = await requirePermission(ctx, orgId, "inbox", "reply");
    await assertAnyModule(ctx, orgId);

    const now = Date.now();
    await ctx.db.patch(conversation._id, { contactKind: args.contactKind, updatedAt: now });
    const lead = await getLeadRef(ctx.db, conversation.leadId);
    if (lead && lead.contactKind !== args.contactKind) {
      await ctx.db.patch(lead._id, { contactKind: args.contactKind, updatedAt: now });
    }
    await ctx.db.insert("auditLogs", {
      organizationId: orgId,
      entityType: "conversation",
      entityId: conversation._id,
      action: "update",
      actorId: actor._id,
      actorType: "human",
      changes: {
        before: { contactKind: conversation.contactKind ?? "lead" },
        after: { contactKind: args.contactKind },
      },
      description: `Classificou o contato como "${args.contactKind}"`,
      severity: "low",
      createdAt: now,
    });
    return null;
  },
});

// ─── Desfecho (Convertido / Não convertido) ─────────────────────────────────

export const markConversationOutcome = mutation({
  args: {
    conversationId: v.id("conversations"),
    outcome: v.union(v.literal("converted"), v.literal("not_converted")),
    value: v.optional(v.number()),
    reason: v.optional(v.string()),
    checkin: v.optional(v.string()), // YYYY-MM-DD
    checkout: v.optional(v.string()),
    guests: v.optional(v.number()),
  },
  returns: v.object({ leadId: v.id("leads"), stageId: v.id("stages") }),
  handler: async (ctx, args) => {
    const conversation = await loadConversation(ctx, args.conversationId);
    const orgId = conversation.organizationId;
    const actor = await requirePermission(ctx, orgId, "leads", "edit_own");
    await assertAnyModule(ctx, orgId);
    const lead = await getLeadRef(ctx.db, conversation.leadId);
    if (!lead || lead.organizationId !== orgId) {
      throw new ConvexError("Esta conversa não tem lead para marcar o desfecho");
    }
    if (args.value !== undefined && (!Number.isFinite(args.value) || args.value < 0)) {
      throw new ConvexError("Valor inválido");
    }

    const stages = await ctx.db
      .query("stages")
      .withIndex("by_board_and_order", (q) => q.eq("boardId", lead.boardId))
      .collect();
    const target =
      args.outcome === "converted"
        ? stages.find((s) => s.isClosedWon)
        : stages.find((s) => s.isClosedLost);
    if (!target) {
      throw new ConvexError(
        args.outcome === "converted"
          ? "O pipeline deste lead não tem estágio de Ganho — crie um em Pipeline antes de marcar como convertido"
          : "O pipeline deste lead não tem estágio de Perdido — crie um em Pipeline antes de marcar como não convertido"
      );
    }

    const customFields: Record<string, unknown> = { ...lead.customFields };
    if (args.checkin !== undefined) customFields.checkin = args.checkin;
    if (args.checkout !== undefined) customFields.checkout = args.checkout;
    if (args.guests !== undefined) customFields.hospedes = args.guests;
    const touchedCustom =
      args.checkin !== undefined || args.checkout !== undefined || args.guests !== undefined;

    await moveLeadToStageCore(ctx, {
      lead,
      newStage: target,
      newStageId: target._id,
      actor,
      closedReason: args.reason?.trim() || undefined,
      finalValue: args.value,
      ...(touchedCustom ? { extraPatch: { customFields } } : {}),
    });
    return { leadId: lead._id, stageId: target._id };
  },
});

// ─── Leitura ────────────────────────────────────────────────────────────────

export const getConversationRouting = query({
  args: { conversationId: v.id("conversations") },
  returns: v.union(
    v.null(),
    v.object({
      unit: v.union(v.null(), v.object({ _id: v.id("units"), name: v.string(), color: v.string() })),
      department: v.union(
        v.null(),
        v.object({ _id: v.id("departments"), name: v.string(), color: v.string() })
      ),
      assignee: v.union(
        v.null(),
        v.object({
          _id: v.id("teamMembers"),
          name: v.string(),
          type: v.union(v.literal("human"), v.literal("ai")),
        })
      ),
      contactKind: contactKindValidator,
      attribution: v.union(v.null(), leadAttributionValidator),
      transfers: v.array(
        v.object({
          _id: v.id("conversationTransfers"),
          createdAt: v.number(),
          byType: v.union(v.literal("human"), v.literal("ai"), v.literal("system")),
          byName: v.union(v.string(), v.null()),
          fromDepartmentName: v.union(v.string(), v.null()),
          toDepartmentName: v.union(v.string(), v.null()),
          fromMemberName: v.union(v.string(), v.null()),
          toMemberName: v.union(v.string(), v.null()),
          note: v.union(v.string(), v.null()),
        })
      ),
      outcome: v.union(
        v.null(),
        v.object({
          status: v.union(v.literal("converted"), v.literal("not_converted")),
          value: v.number(),
          reason: v.union(v.string(), v.null()),
          closedAt: v.union(v.number(), v.null()),
        })
      ),
      firstInboundAt: v.union(v.number(), v.null()),
      firstResponseAt: v.union(v.number(), v.null()),
      firstResponderType: v.union(v.literal("ai"), v.literal("human"), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return null;
    await requirePermission(ctx, conversation.organizationId, "inbox", "view_own");
    const modules = await getModules(ctx, conversation.organizationId);
    if (!modules.units && !modules.departments && !modules.attribution && !modules.central) {
      return null;
    }

    const [unit, department, assignee, lead] = await Promise.all([
      conversation.unitId ? ctx.db.get(conversation.unitId) : null,
      conversation.departmentId ? ctx.db.get(conversation.departmentId) : null,
      conversation.assignedTo ? ctx.db.get(conversation.assignedTo) : null,
      getLeadRef(ctx.db, conversation.leadId),
    ]);

    const transferRows = await ctx.db
      .query("conversationTransfers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
      .order("desc")
      .take(TRANSFER_HISTORY_CAP);
    const nameCache = new Map<string, string | null>();
    const nameOf = async (id: Id<"departments"> | Id<"teamMembers"> | undefined) => {
      if (!id) return null;
      if (!nameCache.has(id)) {
        const doc = (await ctx.db.get(id)) as { name?: string } | null;
        nameCache.set(id, doc?.name ?? null);
      }
      return nameCache.get(id) ?? null;
    };
    const transfers = [];
    for (const row of transferRows) {
      transfers.push({
        _id: row._id,
        createdAt: row.createdAt,
        byType: row.byType,
        byName: await nameOf(row.byMemberId),
        fromDepartmentName: await nameOf(row.fromDepartmentId),
        toDepartmentName: await nameOf(row.toDepartmentId),
        fromMemberName: await nameOf(row.fromMemberId),
        toMemberName: await nameOf(row.toMemberId),
        note: row.note ?? null,
      });
    }

    const sameOrg = <T extends { organizationId: Id<"organizations"> }>(doc: T | null) =>
      doc && doc.organizationId === conversation.organizationId ? doc : null;
    const u = sameOrg(unit);
    const d = sameOrg(department);
    const a = sameOrg(assignee);
    return {
      unit: u ? { _id: u._id, name: u.name, color: u.color } : null,
      department: d ? { _id: d._id, name: d.name, color: d.color } : null,
      assignee: a ? { _id: a._id, name: a.name, type: a.type } : null,
      contactKind: conversation.contactKind ?? lead?.contactKind ?? "lead",
      attribution: lead?.attribution ?? null,
      transfers,
      outcome:
        lead?.closedType
          ? {
              status: lead.closedType === "won" ? ("converted" as const) : ("not_converted" as const),
              value: lead.value,
              reason: lead.closedReason ?? null,
              closedAt: lead.closedAt ?? null,
            }
          : null,
      firstInboundAt: conversation.firstInboundAt ?? null,
      firstResponseAt: conversation.firstResponseAt ?? null,
      firstResponderType: conversation.firstResponderType ?? null,
    };
  },
});

export const getInboxQueues = query({
  args: { organizationId: v.id("organizations") },
  returns: v.object({
    departments: v.array(
      v.object({
        _id: v.id("departments"),
        name: v.string(),
        color: v.string(),
        icon: v.optional(v.string()),
        isEntry: v.optional(v.boolean()),
        openCount: v.number(),
        unreadCount: v.number(),
      })
    ),
    units: v.array(
      v.object({ _id: v.id("units"), name: v.string(), color: v.string(), openCount: v.number() })
    ),
    unassignedCount: v.number(),
    noDepartmentCount: v.number(),
    mineCount: v.number(),
    // true quando a varredura de "Minhas/Sem responsável" bateu no teto.
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const me = await requirePermission(ctx, args.organizationId, "inbox", "view_own");
    const modules = await getModules(ctx, args.organizationId);
    const empty = {
      departments: [],
      units: [],
      unassignedCount: 0,
      noDepartmentCount: 0,
      mineCount: 0,
      truncated: false,
    };
    if (!modules.departments && !modules.units) return empty;

    const departments = modules.departments
      ? await ctx.db
          .query("departments")
          .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
          .take(100)
      : [];
    departments.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    const deptQueues = await Promise.all(
      departments.map(async (d) => ({
        _id: d._id,
        name: d.name,
        color: d.color,
        ...(d.icon ? { icon: d.icon } : {}),
        ...(d.isEntry !== undefined ? { isEntry: d.isEntry } : {}),
        ...(await departmentConversationCounts(ctx, args.organizationId, d._id)),
      }))
    );

    const units = modules.units
      ? await ctx.db
          .query("units")
          .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
          .take(200)
      : [];
    units.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    const unitQueues = await Promise.all(
      units.map(async (u) => {
        const rows = await ctx.db
          .query("conversations")
          .withIndex("by_organization_and_unit", (q) =>
            q.eq("organizationId", args.organizationId).eq("unitId", u._id)
          )
          .order("desc")
          .take(DEPARTMENT_OPEN_COUNT_CAP * 2);
        const openCount = Math.min(
          rows.filter((c) => !c.archivedAt).length,
          DEPARTMENT_OPEN_COUNT_CAP
        );
        return { _id: u._id, name: u.name, color: u.color, openCount };
      })
    );

    const recent = await ctx.db
      .query("conversations")
      .withIndex("by_organization_and_last_message", (q) =>
        q.eq("organizationId", args.organizationId)
      )
      .order("desc")
      .take(INBOX_QUEUE_SCAN_CAP);
    let unassignedCount = 0;
    let noDepartmentCount = 0;
    let mineCount = 0;
    for (const c of recent) {
      if (c.archivedAt || c.kind === "group") continue;
      if (!c.assignedTo) unassignedCount++;
      if (!c.departmentId) noDepartmentCount++;
      if (c.assignedTo === me._id) mineCount++;
    }

    return {
      departments: deptQueues,
      units: unitQueues,
      unassignedCount,
      noDepartmentCount,
      mineCount,
      truncated: recent.length >= INBOX_QUEUE_SCAN_CAP,
    };
  },
});
