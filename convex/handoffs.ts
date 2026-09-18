import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireAuth, requirePermission } from "./lib/auth";
import { createNotification } from "./lib/notify";
import { getLeadRef } from "./lib/leadRef";
import { resolvePermissions, hasPermission, type Role } from "./lib/permissions";
import { batchGet } from "./lib/batchGet";
import { buildAuditDescription } from "./lib/auditDescription";
import { parseCursor, buildCursorFromCreationTime, paginateResults } from "./lib/cursor";
import { appUrl as resolveAppUrl } from "./lib/appUrl";

const APP_URL = () => resolveAppUrl();

/**
 * Quanto tempo a IA de um GRUPO fica em silêncio depois que alguém aceita o
 * repasse daquela sala (review de correção nº 6).
 *
 * No 1 a 1 a pausa é indefinida e faz sentido: a conversa é DAQUELE cliente e o
 * humano que assumiu tem "Devolver à IA" a um clique. Numa sala com dezenas de
 * pessoas o repasse é sobre UM assunto, não sobre a sala inteira — e antes
 * disto o agente do grupo simplesmente nunca mais respondia a uma menção.
 */
export const GROUP_HANDOFF_PAUSE_MS = 24 * 60 * 60 * 1000;

const handoffStatusValidator = v.union(
  v.literal("pending"),
  v.literal("accepted"),
  v.literal("rejected"),
  v.literal("canceled")
);

// De onde veio o repasse — só metadado (audit/activity/webhook), nunca regra.
export type HandoffOrigin = "human" | "ai_keyword" | "ai_tool" | "ai_failure";

const handoffOriginValidator = v.union(
  v.literal("human"),
  v.literal("ai_keyword"),
  v.literal("ai_tool"),
  v.literal("ai_failure")
);

// ── Helpers compartilhados ──

// Conversa "principal" do lead: a mais recente por atividade, preferindo as NÃO
// arquivadas (aceitar um repasse leva o humano para a conversa viva, não para um
// arquivo antigo). Usada como fallback dos repasses sem `conversationId`.
async function resolveLeadPrimaryConversationId(
  ctx: { db: QueryCtx["db"] },
  // Aceita `undefined` porque `handoffs.leadId` é opcional desde a v0.57
  // (repasse vindo de uma conversa de grupo não tem lead): sem lead não há o
  // que resolver, e devolver null é o mesmo caminho de "lead sem conversa".
  leadId: Id<"leads"> | undefined | null
): Promise<Id<"conversations"> | null> {
  if (!leadId) return null;
  const conversations = await ctx.db
    .query("conversations")
    .withIndex("by_lead", (q) => q.eq("leadId", leadId))
    .collect();
  if (conversations.length === 0) return null;

  const byRecency = [...conversations].sort(
    (a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt)
  );
  const active = byRecency.find((c) => c.archivedAt === undefined);
  return (active ?? byRecency[0])._id;
}

// Humanos ativos com direito de RESPONDER no inbox — o público de um repasse
// sem destinatário definido. Cap de 25 p/ proteger a transação em orgs grandes.
async function inboxRepliers(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">
): Promise<Doc<"teamMembers">[]> {
  const members = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) =>
      q.eq("organizationId", organizationId).eq("type", "human")
    )
    .collect();

  return members
    .filter(
      (m) =>
        m.status === "active" &&
        hasPermission(
          resolvePermissions(m.role as Role, m.permissions ?? undefined),
          "inbox",
          "reply"
        )
    )
    .slice(0, 25);
}

/**
 * Criação de repasse — CAMINHO ÚNICO (UI, REST/MCP, palavra-chave do atendente,
 * tool do LLM e falha técnica da fila passam todos por aqui).
 *
 * NÃO pausa a conversa: a condição nº 5 da elegibilidade do atendente
 * (`handoff_pendente`, convex/attendant.ts) já segura a IA enquanto o repasse
 * estiver aberto, e é re-checada no commit transacional. Pausar aqui era a raiz
 * das pausas órfãs (repasse rejeitado deixava a conversa muda para sempre).
 * Quem pausa é o accept — aí sim um humano assumiu.
 */
export async function createHandoffCore(
  ctx: MutationCtx,
  args: {
    /**
     * Ausente num repasse vindo de GRUPO (v0.57): a sala não é um lead. Nesse
     * caso `organizationId` + `conversationId` são obrigatórios e `subjectLabel`
     * (o nome do grupo) vira o título do card.
     */
    leadId?: Id<"leads">;
    organizationId?: Id<"organizations">;
    subjectLabel?: string;
    conversationId?: Id<"conversations">;
    fromMemberId: Id<"teamMembers">;
    toMemberId?: Id<"teamMembers">;
    reason: string;
    summary?: string;
    suggestedActions: string[];
    origin: HandoffOrigin;
    onDuplicate: "skip" | "throw";
  }
): Promise<Id<"handoffs"> | null> {
  const lead = args.leadId ? await ctx.db.get(args.leadId) : null;
  if (args.leadId && !lead) throw new Error("Lead not found");
  const organizationId = lead?.organizationId ?? args.organizationId;
  if (!organizationId) throw new Error("Repasse sem lead precisa da organização");
  // Título do card: o lead quando existe, o nome do grupo quando não.
  const subject = lead?.title ?? args.subjectLabel ?? "Conversa";

  // Guardas de org: ator e destinatário têm de pertencer à org do lead
  const fromMember = await ctx.db.get(args.fromMemberId);
  if (!fromMember || fromMember.organizationId !== organizationId) {
    throw new Error("Membro não pertence à organização do lead");
  }
  const toMember = args.toMemberId ? await ctx.db.get(args.toMemberId) : null;
  if (args.toMemberId && (!toMember || toMember.organizationId !== organizationId)) {
    throw new Error("Destinatário não pertence à organização do lead");
  }

  // Anti-abuso (injeção "peça handoff 50×") e anti-duplicata: no máximo 1
  // repasse em aberto por lead. Gatilhos automáticos usam "skip" (é normal a
  // palavra-chave repetir); pedidos explícitos usam "throw".
  // ATENÇÃO: o runtime da IA detecta este erro por /pendente/ na mensagem.
  if (lead && lead.handoffState && lead.handoffState.status !== "completed") {
    if (args.onDuplicate === "skip") return null;
    throw new Error("Já existe um repasse pendente para este lead");
  }

  // `conversationId` vindo do caller só entra se pertencer ao MESMO lead/org
  // (defesa em profundidade: hoje só o runtime do atendente passa o campo, mas
  // um caller futuro não pode virar escrita cross-tenant no accept).
  let conversationId = args.conversationId;
  if (conversationId) {
    const conv = await ctx.db.get(conversationId);
    if (
      !conv ||
      conv.organizationId !== organizationId ||
      (args.leadId ? conv.leadId !== args.leadId : conv.kind !== "group")
    ) {
      conversationId = undefined;
    }
  }
  conversationId =
    conversationId ??
    (args.leadId ? ((await resolveLeadPrimaryConversationId(ctx, args.leadId)) ?? undefined) : undefined);

  // Sem lead não existe `handoffState` para segurar a duplicata — a chave é a
  // CONVERSA. Sem isto, três menções sensíveis seguidas no grupo abririam três
  // repasses do mesmo assunto.
  if (!lead) {
    if (!conversationId) throw new Error("Repasse sem lead precisa de uma conversa");
    // Índice PRÓPRIO por conversa (review de segurança nº 6): a varredura
    // anterior (`by_organization_and_status` + `.take(100)`, ordem ascendente)
    // perdia o repasse novo assim que a org acumulava 100 pendentes, e aí três
    // menções sensíveis seguidas abriam três cards do mesmo assunto.
    const open = await ctx.db
      .query("handoffs")
      .withIndex("by_conversation_and_status", (q) =>
        q.eq("conversationId", conversationId).eq("status", "pending")
      )
      .first();
    if (open) {
      if (args.onDuplicate === "skip") return null;
      throw new Error("Já existe um repasse pendente para esta conversa");
    }
  }

  const now = Date.now();
  const actorType = fromMember.type === "ai" ? ("ai" as const) : ("human" as const);

  const handoffId = await ctx.db.insert("handoffs", {
    organizationId,
    leadId: args.leadId,
    conversationId,
    // Título do card quando NÃO há lead. O nome da sala está em
    // `groupChats.subject`, a dois saltos de `enrichHandoffs` — congelá-lo aqui
    // é o que faz o card de /app/repasses deixar de sair anônimo (review de
    // correção nº 13).
    ...(!lead && args.subjectLabel ? { subjectLabel: args.subjectLabel.slice(0, 200) } : {}),
    fromMemberId: args.fromMemberId,
    toMemberId: args.toMemberId,
    reason: args.reason,
    summary: args.summary,
    suggestedActions: args.suggestedActions,
    status: "pending",
    createdAt: now,
  });

  if (lead) {
    await ctx.db.patch(lead._id, {
      handoffState: {
        status: "requested",
        fromMemberId: args.fromMemberId,
        toMemberId: args.toMemberId,
        reason: args.reason,
        summary: args.summary,
        suggestedActions: args.suggestedActions,
        requestedAt: now,
      },
      lastActivityAt: now,
      updatedAt: now,
    });
  }

  // Log audit entry
  await ctx.db.insert("auditLogs", {
    organizationId,
    entityType: "handoff",
    entityId: handoffId,
    action: "create",
    actorId: args.fromMemberId,
    actorType,
    metadata: {
      leadId: args.leadId,
      reason: args.reason,
      toMemberId: args.toMemberId,
      title: subject,
      fromMemberName: fromMember.name,
      toMemberName: toMember?.name,
      origin: args.origin,
    },
    description: buildAuditDescription({
      action: "create",
      entityType: "handoff",
      metadata: { title: subject, fromMemberName: fromMember.name, toMemberName: toMember?.name },
    }),
    severity: "medium",
    createdAt: now,
  });

  // Log activity — `activities.leadId` é obrigatório e a timeline é do LEAD.
  // Repasse de grupo não tem onde pendurar o evento (o audit acima registra).
  if (lead) {
    await ctx.db.insert("activities", {
      organizationId,
      leadId: lead._id,
      type: "handoff",
      actorId: args.fromMemberId,
      actorType,
      content: `Repasse solicitado: ${args.reason}${toMember ? ` (para ${toMember.name})` : ""}`,
      metadata: { handoffId, conversationId, toMemberId: args.toMemberId, origin: args.origin },
      createdAt: now,
    });
  }

  // Trigger webhooks
  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId,
    event: "handoff.requested",
    payload: {
      handoffId,
      leadId: args.leadId,
      conversationId,
      reason: args.reason,
      fromMemberId: args.fromMemberId,
      toMemberId: args.toMemberId,
      origin: args.origin,
    },
  });

  // Email notification — só faz sentido com destinatário definido
  if (args.toMemberId) {
    await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
      organizationId,
      recipientMemberId: args.toMemberId,
      eventType: "handoffRequested",
      templateData: {
        leadTitle: subject,
        reason: args.reason,
        suggestedActions: args.suggestedActions,
        fromMemberName: fromMember.name,
        leadUrl: `${APP_URL()}/app/repasses`,
      },
    });
  }
  // Notificação in-app: destinatário definido → só ele; sem destinatário (caso
  // típico: a IA escalou) → broadcast para quem pode responder no inbox.
  // createNotification já pula membros IA, o próprio ator e quem fez opt-out.
  const notification = {
    organizationId,
    type: "handoff_requested" as const,
    title: `Repasse pendente: ${subject}`,
    body: args.reason,
    handoffId,
    conversationId,
    actorId: args.fromMemberId,
  };
  if (args.toMemberId) {
    await createNotification(ctx, { ...notification, memberId: args.toMemberId });
  } else {
    for (const replier of await inboxRepliers(ctx, organizationId)) {
      await createNotification(ctx, { ...notification, memberId: replier._id });
    }
  }

  return handoffId;
}

/**
 * Aceitar = ASSUMIR a conversa: pausa a IA indefinidamente e desarquiva, para o
 * humano cair numa conversa viva. Retorna a conversa (quando existe) para o
 * chamador navegar até ela.
 */
async function acceptHandoffCore(
  ctx: MutationCtx,
  args: { handoff: Doc<"handoffs">; member: Doc<"teamMembers">; notes?: string }
): Promise<Id<"conversations"> | null> {
  const { handoff, member } = args;

  // Guarda de corrida: dois atendentes clicando "aceitar" ao mesmo tempo — o
  // segundo recebe o nome de quem assumiu em vez de sobrescrever a atribuição.
  if (handoff.status !== "pending") {
    if (handoff.status === "accepted" && handoff.acceptedBy) {
      const owner = await ctx.db.get(handoff.acceptedBy);
      throw new Error(`Repasse já aceito por ${owner?.name ?? "outro membro"}`);
    }
    throw new Error("Este repasse já foi resolvido");
  }

  const now = Date.now();

  await ctx.db.patch(handoff._id, {
    status: "accepted",
    acceptedBy: member._id,
    resolvedBy: member._id,
    notes: args.notes,
    resolvedAt: now,
  });

  const lead = await getLeadRef(ctx.db, handoff.leadId);
  if (lead) {
    await ctx.db.patch(lead._id, {
      assignedTo: member._id,
      handoffState: {
        status: "completed",
        fromMemberId: handoff.fromMemberId,
        toMemberId: member._id,
        reason: handoff.reason,
        summary: handoff.summary,
        suggestedActions: handoff.suggestedActions,
        requestedAt: handoff.createdAt,
        completedAt: now,
      },
      lastActivityAt: now,
      updatedAt: now,
    });
  }

  const candidateId =
    handoff.conversationId ?? (await resolveLeadPrimaryConversationId(ctx, handoff.leadId));
  let conversationId: Id<"conversations"> | null = null;
  if (candidateId) {
    const conversation = await ctx.db.get(candidateId);
    // Guard defensivo de tenant: nunca escrever numa conversa de outra org
    // (campo é validado na criação, mas repasse é documento durável).
    if (conversation && conversation.organizationId === handoff.organizationId) {
      conversationId = candidateId;
      await ctx.db.patch(candidateId, {
        // Conversa 1 a 1: pausa indefinida — o humano assumiu e "Devolver à IA"
        // está a um clique no inbox.
        // Sala de GRUPO: pausa de 24 h (review de correção nº 6). Aceitar um
        // repasse de grupo gravava `MAX_SAFE_INTEGER` e o agente da sala nunca
        // mais respondia a uma menção — sem aviso, sem nada na tela que
        // desfizesse. O grupo continua atendido depois que o caso de hoje
        // acabou; quem quiser devolver antes usa "Devolver à IA".
        aiPausedUntil:
          conversation.kind === "group" ? now + GROUP_HANDOFF_PAUSE_MS : Number.MAX_SAFE_INTEGER,
        archivedAt: undefined,
        updatedAt: now,
      });
    }
  }

  // Log audit entry
  const fromMember = await ctx.db.get(handoff.fromMemberId);
  await ctx.db.insert("auditLogs", {
    organizationId: handoff.organizationId,
    entityType: "handoff",
    entityId: handoff._id,
    action: "update",
    actorId: member._id,
    actorType: "human",
    changes: {
      before: { status: "pending" },
      after: { status: "accepted", acceptedBy: member._id },
    },
    metadata: {
      title: lead?.title,
      fromMemberName: fromMember?.name,
      toMemberName: member.name,
    },
    description: buildAuditDescription({
      action: "update",
      entityType: "handoff",
      metadata: { title: lead?.title, fromMemberName: fromMember?.name, toMemberName: member.name },
      changes: {
        before: { status: "pending" },
        after: { status: "accepted", acceptedBy: member._id },
      },
    }),
    severity: "medium",
    createdAt: now,
  });

  // Log activity — `activities.leadId` é obrigatório, então repasse de grupo
  // (sem lead) fica só no audit acima.
  if (handoff.leadId) {
    await ctx.db.insert("activities", {
      organizationId: handoff.organizationId,
      leadId: handoff.leadId,
      type: "handoff",
      actorId: member._id,
      actorType: "human",
      content: `Repasse aceito por ${member.name} — conversa assumida (IA pausada)`,
      metadata: { handoffId: handoff._id, conversationId },
      createdAt: now,
    });
  }

  // Trigger webhooks
  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId: handoff.organizationId,
    event: "handoff.accepted",
    payload: {
      handoffId: handoff._id,
      leadId: handoff.leadId,
      conversationId,
      acceptedBy: member._id,
    },
  });

  // Email notification
  await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
    organizationId: handoff.organizationId,
    recipientMemberId: handoff.fromMemberId,
    eventType: "handoffResolved",
    templateData: {
      leadTitle: lead?.title,
      status: "aceito",
      resolvedByName: member.name,
      leadUrl: `${APP_URL()}/app/pipeline`,
    },
  });

  // Notificação in-app para quem pediu o repasse (no-op quando foi a IA).
  await createNotification(ctx, {
    organizationId: handoff.organizationId,
    memberId: handoff.fromMemberId,
    type: "handoff_resolved",
    title: `Repasse aceito por ${member.name}`,
    body: lead?.title,
    handoffId: handoff._id,
    conversationId: conversationId ?? undefined,
    actorId: member._id,
  });

  return conversationId;
}

/**
 * Rejeitar = DEVOLVER à IA: limpa o `handoffState` (a condição nº 5 da
 * elegibilidade volta a passar) e desfaz pausa órfã herdada dos repasses
 * criados pelo antigo caminho de palavra-chave, que pausavam a conversa.
 */
async function rejectHandoffCore(
  ctx: MutationCtx,
  args: { handoff: Doc<"handoffs">; member: Doc<"teamMembers">; notes?: string }
): Promise<void> {
  const { handoff, member } = args;

  if (handoff.status !== "pending") {
    throw new Error("Este repasse já foi resolvido");
  }

  const now = Date.now();

  await ctx.db.patch(handoff._id, {
    status: "rejected",
    resolvedBy: member._id,
    notes: args.notes,
    resolvedAt: now,
  });

  const lead = await getLeadRef(ctx.db, handoff.leadId);
  if (lead) {
    await ctx.db.patch(lead._id, {
      handoffState: undefined,
      lastActivityAt: now,
      updatedAt: now,
    });
  }

  // Conserto de pausa órfã (legado): repasses criados pela IA no caminho de
  // palavra-chave pausavam a conversa para sempre. Rejeitar devolve à IA —
  // MAS só quando nenhum humano é dono do lead: se alguém clicou "Assumir
  // conversa" no meio do caminho, a pausa é DELE e fica intacta.
  const fromMember = await ctx.db.get(handoff.fromMemberId);
  const humanOwnsLead =
    lead?.assignedTo !== undefined && lead.assignedTo !== handoff.fromMemberId;
  if (fromMember?.type === "ai" && !humanOwnsLead) {
    const candidateId =
      handoff.conversationId ?? (await resolveLeadPrimaryConversationId(ctx, handoff.leadId));
    if (candidateId) {
      const conversation = await ctx.db.get(candidateId);
      if (conversation && conversation.aiPausedUntil !== undefined) {
        await ctx.db.patch(candidateId, { aiPausedUntil: undefined, updatedAt: now });
      }
    }
  }

  // Log audit entry
  await ctx.db.insert("auditLogs", {
    organizationId: handoff.organizationId,
    entityType: "handoff",
    entityId: handoff._id,
    action: "update",
    actorId: member._id,
    actorType: "human",
    changes: {
      before: { status: "pending" },
      after: { status: "rejected", resolvedBy: member._id },
    },
    metadata: {
      title: lead?.title,
      fromMemberName: fromMember?.name,
      toMemberName: member.name,
    },
    description: buildAuditDescription({
      action: "update",
      entityType: "handoff",
      metadata: { title: lead?.title, fromMemberName: fromMember?.name, toMemberName: member.name },
      changes: {
        before: { status: "pending" },
        after: { status: "rejected", resolvedBy: member._id },
      },
    }),
    severity: "medium",
    createdAt: now,
  });

  // Log activity — o rejeitado deixa rastro na timeline do lead (quando há um)
  if (handoff.leadId) {
    await ctx.db.insert("activities", {
      organizationId: handoff.organizationId,
      leadId: handoff.leadId,
      type: "handoff",
      actorId: member._id,
      actorType: "human",
      content: `Repasse rejeitado por ${member.name} — devolvido à IA`,
      metadata: { handoffId: handoff._id },
      createdAt: now,
    });
  }

  // Trigger webhooks
  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId: handoff.organizationId,
    event: "handoff.rejected",
    payload: { handoffId: handoff._id, leadId: handoff.leadId, rejectedBy: member._id },
  });

  // Email notification
  await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
    organizationId: handoff.organizationId,
    recipientMemberId: handoff.fromMemberId,
    eventType: "handoffResolved",
    templateData: {
      leadTitle: lead?.title,
      status: "rejeitado",
      resolvedByName: member.name,
      leadUrl: `${APP_URL()}/app/pipeline`,
    },
  });

  // Notificação in-app para quem pediu o repasse (no-op quando foi a IA).
  await createNotification(ctx, {
    organizationId: handoff.organizationId,
    memberId: handoff.fromMemberId,
    type: "handoff_resolved",
    title: `Repasse devolvido à IA por ${member.name}`,
    body: lead?.title,
    handoffId: handoff._id,
    conversationId: handoff.conversationId,
    actorId: member._id,
  });
}

// Enriquecimento comum das listagens: lead/contato/membros + conversa do
// repasse (campo novo, com fallback para os documentos antigos).
async function enrichHandoffs(ctx: QueryCtx, handoffs: Doc<"handoffs">[]) {
  const [leadMap, memberMap] = await Promise.all([
    batchGet(ctx.db, handoffs.map(h => h.leadId)),
    batchGet(ctx.db, [
      ...handoffs.map(h => h.fromMemberId),
      ...handoffs.map(h => h.toMemberId),
      ...handoffs.map(h => h.acceptedBy),
    ]),
  ]);
  const contactMap = await batchGet(ctx.db, Array.from(leadMap.values()).map((l: any) => l?.contactId));

  const enriched = [];
  for (const handoff of handoffs) {
    const lead = handoff.leadId ? leadMap.get(handoff.leadId) ?? null : null;
    enriched.push({
      ...handoff,
      // Título pronto para a UI: o lead quando existe, o nome da sala quando o
      // repasse é de grupo. A UI não precisa mais saber qual dos dois é.
      title: lead?.title ?? handoff.subjectLabel ?? "Conversa",
      isGroup: handoff.leadId === undefined,
      // Fallback do campo novo SÓ para pendentes (é onde a UI navega/espia).
      // Resolver para listagens históricas viraria N+1 de collect() por linha
      // em repasses antigos sem o campo (REST lê até 500).
      conversationId:
        handoff.conversationId ??
        (handoff.status === "pending"
          ? await resolveLeadPrimaryConversationId(ctx, handoff.leadId)
          : null),
      lead,
      contact: lead?.contactId ? contactMap.get(lead.contactId) ?? null : null,
      fromMember: memberMap.get(handoff.fromMemberId) ?? null,
      toMember: handoff.toMemberId ? memberMap.get(handoff.toMemberId) ?? null : null,
      acceptedBy: handoff.acceptedBy ? memberMap.get(handoff.acceptedBy) ?? null : null,
    });
  }
  return enriched;
}

// Get handoffs for organization
export const getHandoffs = query({
  args: {
    organizationId: v.id("organizations"),
    status: v.optional(handoffStatusValidator),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "inbox", "view_own");

    let query = ctx.db.query("handoffs").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId));

    if (args.status) {
      query = ctx.db.query("handoffs").withIndex("by_organization_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("status", args.status!)
      );
    }

    // Mais recentes primeiro — a fila mostra o repasse novo no topo.
    const handoffs = await query.order("desc").take(args.limit ?? 200);

    return await enrichHandoffs(ctx, handoffs);
  },
});

/**
 * Repasses pendentes da org (badge da sidebar). Mesmo gate de visibilidade do
 * item de navegação (inbox:view_own).
 */
export const getPendingHandoffCount = query({
  args: { organizationId: v.id("organizations") },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "inbox", "view_own");
    const pending = await ctx.db
      .query("handoffs")
      .withIndex("by_organization_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("status", "pending")
      )
      .collect();
    return pending.length;
  },
});

/**
 * Repasse em aberto de um lead — alimenta o banner do inbox (o atendente vê que
 * a IA pediu ajuda sem sair da conversa). Retorna só o essencial do repasse;
 * null quando o lead não existe ou não tem nada pendente.
 */
export const getPendingHandoffForLead = query({
  args: { leadId: v.id("leads") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) return null;

    await requirePermission(ctx, lead.organizationId, "inbox", "view_own");

    const handoffs = await ctx.db
      .query("handoffs")
      .withIndex("by_lead", (q) => q.eq("leadId", args.leadId))
      .collect();

    // Só existe 1 pendente por lead (garantido na criação), mas ordenamos por
    // segurança contra dados legados.
    const pending = handoffs
      .filter((h) => h.status === "pending")
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!pending) return null;

    return {
      _id: pending._id,
      reason: pending.reason,
      summary: pending.summary,
      suggestedActions: pending.suggestedActions,
      createdAt: pending.createdAt,
      conversationId:
        pending.conversationId ?? (await resolveLeadPrimaryConversationId(ctx, args.leadId)),
    };
  },
});

/**
 * Repasse pendente DESTA conversa — o caminho de quem não tem lead (sala de
 * grupo). O banner âmbar do inbox saía só para o 1 a 1, porque a fonte dele era
 * `conversation.lead.handoffState`: numa sala, o operador não via nem que havia
 * repasse aberto, nem o botão de aceitar inline.
 */
export const getPendingHandoffForConversation = query({
  args: { conversationId: v.id("conversations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return null;
    await requirePermission(ctx, conversation.organizationId, "inbox", "view_own");

    const pending = await ctx.db
      .query("handoffs")
      .withIndex("by_conversation_and_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "pending")
      )
      .first();
    if (!pending) return null;

    return {
      _id: pending._id,
      reason: pending.reason,
      summary: pending.summary,
      suggestedActions: pending.suggestedActions,
      createdAt: pending.createdAt,
      conversationId: pending.conversationId ?? args.conversationId,
      title: pending.subjectLabel ?? null,
    };
  },
});

// Request handoff
export const requestHandoff = mutation({
  args: {
    leadId: v.id("leads"),
    toMemberId: v.optional(v.id("teamMembers")),
    reason: v.string(),
    summary: v.optional(v.string()),
    suggestedActions: v.array(v.string()),
  },
  returns: v.id("handoffs"),
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");

    const userMember = await requireAuth(ctx, lead.organizationId);

    // onDuplicate "throw": pedido explícito com repasse em aberto é erro visível
    const handoffId = await createHandoffCore(ctx, {
      leadId: args.leadId,
      fromMemberId: userMember._id,
      toMemberId: args.toMemberId,
      reason: args.reason,
      summary: args.summary,
      suggestedActions: args.suggestedActions,
      origin: "human",
      onDuplicate: "throw",
    });

    return handoffId!;
  },
});

// Accept handoff
export const acceptHandoff = mutation({
  args: {
    handoffId: v.id("handoffs"),
    notes: v.optional(v.string()),
  },
  returns: v.object({ conversationId: v.union(v.id("conversations"), v.null()) }),
  handler: async (ctx, args) => {
    const handoff = await ctx.db.get(args.handoffId);
    if (!handoff) throw new Error("Handoff not found");

    const userMember = await requirePermission(ctx, handoff.organizationId, "inbox", "reply");

    const conversationId = await acceptHandoffCore(ctx, {
      handoff,
      member: userMember,
      notes: args.notes,
    });

    return { conversationId };
  },
});

// Reject handoff — `instruction` opcional: rejeitar RESPONDENDO o que a IA
// precisava ("o Pix é X, o valor é 50"). Além do reject, aplica a devolução
// plena à IA (despausa + lead de volta ao atendente) e dispara um turno
// instruído via internal.attendant.internalQueueInstructedTurn (scheduler —
// import direto criaria ciclo handoffs↔attendant); a instrução também persiste
// como nota da equipe na conversa e vale para os turnos seguintes.
export const rejectHandoff = mutation({
  args: {
    handoffId: v.id("handoffs"),
    notes: v.optional(v.string()),
    instruction: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const handoff = await ctx.db.get(args.handoffId);
    if (!handoff) throw new Error("Handoff not found");

    const userMember = await requirePermission(ctx, handoff.organizationId, "inbox", "reply");

    const instruction = args.instruction?.trim() || undefined;
    // Espelha attendant.MAX_INSTRUCTION_CHARS (2000).
    if (instruction && instruction.length > 2000) {
      throw new Error("Instrução muito longa (máx. 2000 caracteres)");
    }

    await rejectHandoffCore(ctx, {
      handoff,
      member: userMember,
      notes: args.notes ?? instruction,
    });

    if (instruction) {
      const conversationId =
        handoff.conversationId ?? (await resolveLeadPrimaryConversationId(ctx, handoff.leadId));
      if (conversationId) {
        await ctx.scheduler.runAfter(0, internal.attendant.internalQueueInstructedTurn, {
          conversationId,
          instructedBy: userMember._id,
          instruction,
        });
      }
    }
    return null;
  },
});

// ── Internal functions (for httpAction context, no auth session) ──

// Internal: Get handoffs for organization
export const internalGetHandoffs = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    status: v.optional(handoffStatusValidator),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 200, 500);
    const cursor = parseCursor(args.cursor);
    const overRead = limit + 1 + (cursor ? limit * 3 : 0);

    let query = ctx.db.query("handoffs").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId));

    if (args.status) {
      query = ctx.db.query("handoffs").withIndex("by_organization_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("status", args.status!)
      );
    }

    const rawHandoffs = await query.order("desc").take(overRead);

    let filtered = rawHandoffs;
    if (cursor) {
      filtered = rawHandoffs.filter(
        (h) =>
          h._creationTime < cursor.ts ||
          (h._creationTime === cursor.ts && h._id < cursor.id)
      );
    }

    const { items: handoffs, nextCursor, hasMore } = paginateResults(
      filtered, limit, buildCursorFromCreationTime
    );

    return { handoffs: await enrichHandoffs(ctx, handoffs), nextCursor, hasMore };
  },
});

// Internal: Request handoff
export const internalRequestHandoff = internalMutation({
  args: {
    leadId: v.id("leads"),
    conversationId: v.optional(v.id("conversations")),
    toMemberId: v.optional(v.id("teamMembers")),
    reason: v.string(),
    summary: v.optional(v.string()),
    suggestedActions: v.array(v.string()),
    teamMemberId: v.id("teamMembers"),
    origin: v.optional(handoffOriginValidator),
  },
  returns: v.id("handoffs"),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    // Guardas de org (ator/destinatário) ficam no core — caminho único.
    const handoffId = await createHandoffCore(ctx, {
      leadId: args.leadId,
      conversationId: args.conversationId,
      fromMemberId: args.teamMemberId,
      toMemberId: args.toMemberId,
      reason: args.reason,
      summary: args.summary,
      suggestedActions: args.suggestedActions,
      origin: args.origin ?? (teamMember.type === "ai" ? "ai_tool" : "human"),
      onDuplicate: "throw",
    });

    return handoffId!;
  },
});

// Internal: Accept handoff
export const internalAcceptHandoff = internalMutation({
  args: {
    handoffId: v.id("handoffs"),
    notes: v.optional(v.string()),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const handoff = await ctx.db.get(args.handoffId);
    if (!handoff) throw new Error("Handoff not found");
    // Guarda de org: o ator tem de pertencer à org do handoff
    if (teamMember.organizationId !== handoff.organizationId) {
      throw new Error("Membro não pertence à organização do repasse");
    }

    await acceptHandoffCore(ctx, { handoff, member: teamMember, notes: args.notes });

    return null;
  },
});

// Internal: Reject handoff
export const internalRejectHandoff = internalMutation({
  args: {
    handoffId: v.id("handoffs"),
    notes: v.optional(v.string()),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const handoff = await ctx.db.get(args.handoffId);
    if (!handoff) throw new Error("Handoff not found");
    // Guarda de org: o ator tem de pertencer à org do handoff
    if (teamMember.organizationId !== handoff.organizationId) {
      throw new Error("Membro não pertence à organização do repasse");
    }

    await rejectHandoffCore(ctx, { handoff, member: teamMember, notes: args.notes });

    return null;
  },
});
