/**
 * Shared inbound routing: find-or-create a contact by phone and ensure the
 * contact has a lead on the org's default board (with AI auto-assign).
 * Used by the WhatsApp webhook ingress and the /api/v1/conversations/receive
 * endpoint (same logic as the /api/v1/inbound/lead flow).
 */
import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { buildSearchText } from "./searchText";
import { orgAiActive } from "./agentSecurity";
import { configProvider } from "../channelConfigs";

/**
 * Atendente IA responsável por um CANAL (v4.1 P4 — resolvido ANTES do lead
 * existir, então sem filtro de board). Usado pelo roteamento inbound para
 * aplicar o pipelineConfig do atendente na criação do lead. Mesmos gates do
 * runtime: org com IA ativa, toggle do atendente ligado, bridge só com o
 * aceite de risco vigente.
 */
export async function findAttendantForChannel(
  ctx: MutationCtx,
  org: Doc<"organizations"> | null,
  config: Doc<"channelConfigs">
): Promise<Doc<"teamMembers"> | null> {
  if (!orgAiActive(org)) return null;
  const aiConfig = org!.settings.aiConfig;
  if (aiConfig?.attendantEnabled === false) return null;
  if (config.status !== "active") return null;
  if (configProvider(config) === "bridge" && aiConfig?.bridgeAiAck === undefined) return null;

  const aiMembers = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) =>
      q.eq("organizationId", config.organizationId).eq("type", "ai")
    )
    .collect();
  for (const member of aiMembers) {
    const profile = member.agentProfile;
    if (member.status !== "active" || profile?.kind !== "attendant") continue;
    if (
      profile.channelConfigIds &&
      profile.channelConfigIds.length > 0 &&
      !profile.channelConfigIds.includes(config._id)
    ) {
      continue;
    }
    return member;
  }
  return null;
}

export async function findOrCreateContactByPhone(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    phone: string;
    firstName?: string;
    lastName?: string;
  }
): Promise<Id<"contacts">> {
  const existing = await ctx.db
    .query("contacts")
    .withIndex("by_organization_and_phone", (q) =>
      q.eq("organizationId", args.organizationId).eq("phone", args.phone)
    )
    .first();

  if (existing) {
    // Backfill the name from the channel profile if we don't have one yet
    if (!existing.firstName && args.firstName) {
      await ctx.db.patch(existing._id, {
        firstName: args.firstName,
        searchText: buildSearchText({ ...existing, firstName: args.firstName }),
        updatedAt: Date.now(),
      });
    }
    return existing._id;
  }

  const now = Date.now();
  return await ctx.db.insert("contacts", {
    organizationId: args.organizationId,
    firstName: args.firstName,
    lastName: args.lastName,
    phone: args.phone,
    whatsappNumber: args.phone,
    tags: [],
    searchText: buildSearchText(args),
    createdAt: now,
    updatedAt: now,
  });
}

export async function ensureLeadForContact(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    contactId: Id<"contacts">;
    title?: string;
    // v4.1 P4: board/estágio preferidos (pipelineConfig do atendente do canal).
    // Inválidos/deletados NUNCA quebram o ingest — fallback ao default + aviso.
    preferredBoardId?: Id<"boards">;
    preferredStageId?: Id<"stages">;
  }
): Promise<Id<"leads">> {
  // Most recent lead for this contact in this org
  const leads = await ctx.db
    .query("leads")
    .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
    .order("desc")
    .take(50);
  const existing = leads.find((l) => l.organizationId === args.organizationId);
  if (existing) return existing._id;

  // Default board + first stage
  const boards = await ctx.db
    .query("boards")
    .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
    .collect();
  const defaultBoard = boards.find((b) => b.isDefault) ?? boards[0];
  if (!defaultBoard) throw new Error("No boards configured");

  let pipelineFallback: string | null = null;
  let board = defaultBoard;
  if (args.preferredBoardId) {
    const preferred = boards.find((b) => b._id === args.preferredBoardId);
    if (preferred) {
      board = preferred;
    } else {
      pipelineFallback = "funil configurado no atendente não existe mais";
    }
  }

  const stages = await ctx.db
    .query("stages")
    .withIndex("by_board_and_order", (q) => q.eq("boardId", board._id))
    .collect();
  let firstStage = stages[0];
  if (!firstStage) throw new Error("No stages configured");
  if (args.preferredStageId && !pipelineFallback) {
    const preferredStage = stages.find((s) => s._id === args.preferredStageId);
    if (preferredStage) {
      firstStage = preferredStage;
    } else {
      pipelineFallback = "estágio inicial configurado no atendente não existe mais neste funil";
    }
  }

  // Auto-assign to an active AI member if the org opted in
  let assignedTo: Id<"teamMembers"> | undefined;
  const org = await ctx.db.get(args.organizationId);
  if (org?.settings.aiConfig?.autoAssign) {
    const aiMembers = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_type", (q) =>
        q.eq("organizationId", args.organizationId).eq("type", "ai")
      )
      .collect();
    // Só o atendente (não o copiloto) pode ser dono automático de um lead —
    // atribuir ao copiloto trava a condição nº 6 da elegibilidade (lead_de_humano).
    assignedTo = aiMembers.find(
      (m) => m.status === "active" && m.agentProfile?.kind === "attendant"
    )?._id;
  }

  const contact = await ctx.db.get(args.contactId);
  const contactName =
    [contact?.firstName, contact?.lastName].filter(Boolean).join(" ") ||
    contact?.phone ||
    contact?.email ||
    "Unknown contact";
  const title = args.title || contactName;

  const now = Date.now();
  const leadId = await ctx.db.insert("leads", {
    organizationId: args.organizationId,
    title,
    contactId: args.contactId,
    boardId: board._id,
    stageId: firstStage._id,
    assignedTo,
    value: 0,
    currency: org?.settings.currency || "USD",
    priority: "medium",
    temperature: "cold",
    tags: [],
    customFields: {},
    conversationStatus: "new",
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db.insert("activities", {
    organizationId: args.organizationId,
    leadId,
    type: "created",
    actorType: "system",
    content: `Lead criado automaticamente a partir de mensagem recebida`,
    metadata: { contactId: args.contactId },
    createdAt: now,
  });

  if (pipelineFallback) {
    await ctx.db.insert("activities", {
      organizationId: args.organizationId,
      leadId,
      type: "note",
      actorType: "system",
      content: `Configuração de funil do atendente ignorada (${pipelineFallback}) — lead criado no funil padrão. Revise as Opções avançadas do atendente.`,
      metadata: { contactId: args.contactId, pipelineConfigFallback: true },
      createdAt: now,
    });
  }

  await ctx.db.insert("auditLogs", {
    organizationId: args.organizationId,
    entityType: "lead",
    entityId: leadId,
    action: "create",
    actorType: "system",
    metadata: { title, contactId: args.contactId, source: "inbound_message" },
    description: `Criou o lead '${title}' automaticamente a partir de mensagem recebida`,
    severity: "medium",
    createdAt: now,
  });

  return leadId;
}
