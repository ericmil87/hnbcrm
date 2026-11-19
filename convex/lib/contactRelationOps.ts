/**
 * Porta ÚNICA do tipo de contato (PR1 "Não é cliente / Virar lead"). Chamada
 * pela mutation do app (`contacts.setContactRelation*`), REST/MCP
 * (`contacts.internalUpdateContact`), Telegram (`lib/telegramActions.ts`, verbo
 * `pe`), importação (`imports.ts`) e ops (`opsContactRelation.ts`). Nunca grave
 * `contacts.relation` por fora daqui.
 *
 * Efeitos, numa transação:
 * 1. `relation` + `relationMeta` no contato; espelho `contactRelation` nas
 *    conversas dos leads do contato.
 * 2. Virou fora do comercial: leads abertos arquivados (`setLeadArchivedCore`,
 *    activity "Arquivado: contato Pessoal"); follow-ups cancelados
 *    (`resolveFollowUpOutcome` via `cancelFollowUpsOfLead`); repasse pendente
 *    `canceled` com `metadata.reason:"non_customer"`; rascunho pendente da IA
 *    descartado (`discardAiDraftCore`); suspeita de robô encerrada. Uma rodada
 *    da IA em voo morre no claim/commit (condição 0b da elegibilidade).
 * 3. Virou cliente / limpou (`restoreLead`, padrão quando vinha de fora do
 *    comercial): desarquiva o lead mais recente ou, sem lead nenhum, cria um na
 *    etapa inicial do atendente (`ensureLeadForContact`).
 * 4. activity no lead mais recente + audit (exceto `quiet`) +
 *    `scheduleWebhookEvent("contact.updated")`.
 *
 * Só humanos marcam (membro IA → erro): quem chama já checou `contacts:edit`.
 * Não importa `attendant.ts`/`handoffs.ts` (ciclo): o rascunho sai por
 * `lib/aiDraftOps.ts` e o repasse é encerrado aqui mesmo.
 */
import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  CONTACT_RELATION_LABEL,
  defaultRestoreLead,
  isOffBusiness,
  type ContactRelation,
  type ContactRelationSource,
} from "./contactRelation";
import { syncContactRelationMirrorForLead, MIRROR_CONVERSATIONS_PER_LEAD } from "./contactRelationGuard";
import { setLeadArchivedCore } from "./leadArchive";
import { cancelFollowUpsOfLead } from "./followUpOps";
import { discardAiDraftCore } from "./aiDraftOps";
import { hasActiveBotSuspicion } from "./botGuardOps";
import { resolveEntityNotifications } from "./notificationResolve";
import { maybeScheduleHandoffCardsUpdate } from "./telegramRelay";
import { scheduleWebhookEvent } from "./webhookDispatch";
import { ensureLeadForContact } from "./inboundRouting";

/**
 * Teto de leads do contato que a porta percorre (o mais recente primeiro). Um
 * contato tem 1–3 leads na prática; cada lead custa conversas + mensagens
 * recentes + repasses, então o teto protege a transação de um contato atípico.
 */
export const RELATION_LEADS_CAP = 10;
/** Mensagens recentes olhadas atrás de um rascunho pendente (o rascunho é sempre recente). */
const DRAFT_SCAN = 15;
/** Ações pendentes do Copiloto/Telegram lidas por execução (`by_organization_and_status`). */
const PENDING_ACTIONS_SCAN = 200;
/** Ferramentas de atendimento com ação pendente endereçada a uma conversa (`args.conversationId`). */
const CONVERSATION_PENDING_TOOLS: ReadonlySet<string> = new Set([
  "instructAttendant",
  "sendCustomerReply",
  "acceptHandoff",
  "regenerateAiReply",
]);

export const NON_CUSTOMER_HANDOFF_REASON = "non_customer";

export type SetContactRelationResult = {
  previous: ContactRelation | null;
  relation: ContactRelation | null;
  archivedLeads: number;
  /** Leads arquivados POR ESTA chamada (o Desfazer devolve exatamente estes em `restoreLeadIds`). */
  archivedLeadIds: Id<"leads">[];
  /** Primeiro lead restaurado/criado, ou null. */
  restoredLeadId: Id<"leads"> | null;
};

export const AI_ACTOR_RELATION_ERROR =
  "Só uma pessoa da equipe pode mudar o tipo de contato (a IA não marca nem converte contatos).";

/** Membro IA nunca marca/converte. Lança `ConvexError` PT-BR. */
export function assertHumanRelationActor(member: Pick<Doc<"teamMembers">, "type">): void {
  if (member.type === "ai") throw new ConvexError(AI_ACTOR_RELATION_ERROR);
}

async function leadsOfContact(ctx: MutationCtx, contact: Doc<"contacts">): Promise<Doc<"leads">[]> {
  // `by_contact` em ordem de criação desc: o primeiro é o lead mais recente.
  const leads = await ctx.db
    .query("leads")
    .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
    .order("desc")
    .take(RELATION_LEADS_CAP);
  return leads.filter((l) => l.organizationId === contact.organizationId);
}

/** Repasses pendentes do lead → `canceled` + `metadata.reason:"non_customer"`. */
async function cancelPendingHandoffsOfLead(
  ctx: MutationCtx,
  lead: Doc<"leads">,
  actor: Doc<"teamMembers">,
  now: number,
): Promise<number> {
  const handoffs = await ctx.db
    .query("handoffs")
    .withIndex("by_lead", (q) => q.eq("leadId", lead._id))
    .order("desc")
    .take(50);
  let canceled = 0;
  for (const handoff of handoffs) {
    if (handoff.status !== "pending" || handoff.organizationId !== lead.organizationId) continue;
    await ctx.db.patch(handoff._id, {
      status: "canceled",
      resolvedBy: actor._id,
      resolvedAt: now,
      metadata: { ...(handoff.metadata ?? {}), reason: NON_CUSTOMER_HANDOFF_REASON },
    });
    await resolveEntityNotifications(ctx, {
      organizationId: lead.organizationId,
      target: { handoffId: handoff._id },
      resolvedByMemberId: actor._id,
      reason: "handoff_canceled",
      types: ["handoff_requested"],
    });
    await scheduleWebhookEvent(ctx, {
      organizationId: lead.organizationId,
      event: "handoff.canceled",
      payload: {
        handoffId: handoff._id,
        leadId: lead._id,
        conversationId: handoff.conversationId,
        canceledBy: actor._id,
        reason: NON_CUSTOMER_HANDOFF_REASON,
      },
    });
    await maybeScheduleHandoffCardsUpdate(ctx, handoff._id);
    canceled += 1;
  }
  if (lead.handoffState) {
    await ctx.db.patch(lead._id, { handoffState: undefined, updatedAt: now });
  }
  return canceled;
}

/**
 * Ações pendentes do Copiloto/Telegram (cartões `pa:`) endereçadas às conversas
 * do contato → `canceled`. Ninguém confirma depois uma instrução à IA ou uma
 * resposta redigida pelo Copiloto para quem virou não-cliente. Patch direto:
 * `cancelPendingActionCore` só aceita o próprio solicitante.
 */
async function cancelPendingActionsOfConversations(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  conversationIds: ReadonlySet<string>,
): Promise<number> {
  if (conversationIds.size === 0) return 0;
  const pending = await ctx.db
    .query("pendingActions")
    .withIndex("by_organization_and_status", (q) => q.eq("organizationId", organizationId).eq("status", "pending"))
    .take(PENDING_ACTIONS_SCAN);
  let canceled = 0;
  for (const action of pending) {
    const target = action.args.conversationId;
    if (!CONVERSATION_PENDING_TOOLS.has(action.tool) || typeof target !== "string" || !conversationIds.has(target)) continue;
    await ctx.db.patch(action._id, { status: "canceled" });
    canceled += 1;
  }
  return canceled;
}

/** Rascunho pendente da IA e suspeita de robô de cada conversa 1:1 do lead. Devolve os ids das conversas. */
async function quietConversationsOfLead(
  ctx: MutationCtx,
  lead: Doc<"leads">,
  actor: Doc<"teamMembers">,
  now: number,
): Promise<Id<"conversations">[]> {
  const conversations = await ctx.db
    .query("conversations")
    .withIndex("by_lead", (q) => q.eq("leadId", lead._id))
    .take(MIRROR_CONVERSATIONS_PER_LEAD);
  const ids: Id<"conversations">[] = [];
  for (const conversation of conversations) {
    if (conversation.kind === "group" || conversation.organizationId !== lead.organizationId) continue;
    ids.push(conversation._id);
    // A suspeita de robô deixa de valer: o tipo do contato já diz quem é (e a
    // condição 0b segura a IA). Sem a activity "volta a atender" do
    // `clearBotSuspicion`, que aqui seria falsa.
    if (hasActiveBotSuspicion(conversation)) {
      await ctx.db.patch(conversation._id, {
        botSuspicion: { ...conversation.botSuspicion!, clearedAt: now, clearedBy: actor._id },
        updatedAt: now,
      });
    }
    // Conversa sem nenhuma mensagem não tem rascunho: nem lê as mensagens.
    if (conversation.lastMessageAt === undefined && conversation.messageCount === 0) continue;
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversation._id))
      .order("desc")
      .take(DRAFT_SCAN);
    for (const message of recent) {
      if ((message.metadata?.aiDraft as { status?: string } | undefined)?.status === "pending") {
        await discardAiDraftCore(ctx, { draft: message, member: actor, via: "contact_relation" });
      }
    }
  }
  return ids;
}

/** Pipeline do atendente para o lead criado no "Virar lead" (sem conversa para resolver o canal). */
async function attendantPipeline(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
): Promise<{ boardId?: Id<"boards">; initialStageId?: Id<"stages"> } | undefined> {
  const aiMembers = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) => q.eq("organizationId", organizationId).eq("type", "ai"))
    .take(20);
  const attendant = aiMembers.find((m) => m.status === "active" && m.agentProfile?.kind === "attendant");
  return attendant?.agentProfile?.pipelineConfig;
}

export async function setContactRelationCore(
  ctx: MutationCtx,
  args: {
    contact: Doc<"contacts">;
    relation: ContactRelation | null;
    /** Membro HUMANO da org do contato (o chamador autorizou `contacts:edit`). */
    actor: Doc<"teamMembers">;
    source: ContactRelationSource;
    /** Padrão `defaultRestoreLead`: só ao sair de um tipo fora do comercial. */
    restoreLead?: boolean;
    /**
     * Desfazer preciso: restaura EXATAMENTE estes leads (do contato e da org;
     * outro id = erro) em vez do mais recente, e nunca cria lead. Ignorado ao
     * marcar um tipo fora do comercial.
     */
    restoreLeadIds?: Id<"leads">[];
    /** Importação/ops: sem audit por contato (um audit por job/execução). */
    quiet?: boolean;
  },
): Promise<SetContactRelationResult> {
  const { contact, relation, actor, source } = args;
  if (actor.organizationId !== contact.organizationId) {
    throw new ConvexError("Membro não pertence à organização do contato");
  }
  assertHumanRelationActor(actor);

  const previous: ContactRelation | null = contact.relation ?? null;
  const result: SetContactRelationResult = {
    previous,
    relation,
    archivedLeads: 0,
    archivedLeadIds: [],
    restoredLeadId: null,
  };
  if (previous === relation) return result;

  const now = Date.now();
  await ctx.db.patch(contact._id, {
    relation: relation ?? undefined,
    relationMeta: { setAt: now, setBy: actor._id, source },
    updatedAt: now,
  });

  const leads = await leadsOfContact(ctx, contact);
  for (const lead of leads) {
    await syncContactRelationMirrorForLead(ctx, lead._id, relation ?? undefined);
  }

  const label = relation ? CONTACT_RELATION_LABEL[relation] : "sem tipo";
  const actorRef = { id: actor._id, type: "human" as const };

  if (isOffBusiness(relation)) {
    const conversationIds = new Set<string>();
    for (const lead of leads) {
      const archived = await setLeadArchivedCore(ctx, {
        lead,
        archived: true,
        actor: actorRef,
        now,
        activityContent: `Arquivado: contato ${label}`,
        followUpReason: "contato_nao_cliente",
        auditMetadata: { via: "contact_relation", contactRelation: relation },
      });
      if (archived) {
        result.archivedLeads += 1;
        result.archivedLeadIds.push(lead._id);
      }
      // Lead já arquivado também pode ter follow-up vivo (arquivado por fora antes do PR1).
      else await cancelFollowUpsOfLead(ctx, lead._id, "contato_nao_cliente");
      const fresh = (await ctx.db.get(lead._id)) ?? lead;
      await cancelPendingHandoffsOfLead(ctx, fresh, actor, now);
      for (const id of await quietConversationsOfLead(ctx, fresh, actor, now)) conversationIds.add(id);
    }
    await cancelPendingActionsOfConversations(ctx, contact.organizationId, conversationIds);
  } else if (args.restoreLeadIds !== undefined) {
    // Desfazer preciso: só os leads que o front recebeu em `archivedLeadIds`.
    if (args.restoreLeadIds.length > RELATION_LEADS_CAP) {
      throw new ConvexError(`No máximo ${RELATION_LEADS_CAP} leads por vez`);
    }
    for (const leadId of args.restoreLeadIds) {
      const lead = await ctx.db.get(leadId);
      if (!lead || lead.organizationId !== contact.organizationId || lead.contactId !== contact._id) {
        throw new ConvexError("Lead não pertence a este contato");
      }
      const restored = await setLeadArchivedCore(ctx, {
        lead,
        archived: false,
        actor: actorRef,
        now,
        activityContent: `Restaurado: contato virou ${relation ? CONTACT_RELATION_LABEL[relation] : "sem tipo"}`,
        auditMetadata: { via: "contact_relation", contactRelation: relation },
      });
      if (restored && result.restoredLeadId === null) result.restoredLeadId = lead._id;
    }
  } else if (args.restoreLead ?? defaultRestoreLead(previous, relation)) {
    const mostRecent = leads[0];
    if (mostRecent) {
      const restored = await setLeadArchivedCore(ctx, {
        lead: mostRecent,
        archived: false,
        actor: actorRef,
        now,
        activityContent: `Restaurado: contato virou ${relation ? CONTACT_RELATION_LABEL[relation] : "lead"}`,
        auditMetadata: { via: "contact_relation", contactRelation: relation },
      });
      if (restored) result.restoredLeadId = mostRecent._id;
    } else {
      // Sem lead nenhum: a porta de criação do ingest (etapa inicial do atendente).
      result.restoredLeadId = await ensureLeadForContact(ctx, {
        organizationId: contact.organizationId,
        contactId: contact._id,
        resolvePipeline: () => attendantPipeline(ctx, contact.organizationId),
      });
    }
  }

  const timelineLeadId = result.restoredLeadId ?? leads[0]?._id;
  if (timelineLeadId) {
    await ctx.db.insert("activities", {
      organizationId: contact.organizationId,
      leadId: timelineLeadId,
      type: "note",
      actorId: actor._id,
      actorType: "human",
      content: relation
        ? `${actor.name} marcou o contato como ${label}`
        : `${actor.name} tirou o tipo do contato`,
      metadata: { contactId: contact._id, contactRelation: relation, previous, source },
      createdAt: now,
    });
  }

  const contactName = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || undefined;
  if (!args.quiet) {
    await ctx.db.insert("auditLogs", {
      organizationId: contact.organizationId,
      entityType: "contact",
      entityId: contact._id,
      action: "update",
      actorId: actor._id,
      actorType: "human",
      changes: { before: { relation: previous }, after: { relation } },
      metadata: {
        source,
        archivedLeads: result.archivedLeads,
        restoredLeadId: result.restoredLeadId,
        ...(contactName ? { name: contactName } : {}),
      },
      description: relation
        ? `Marcou o contato${contactName ? ` '${contactName}'` : ""} como ${label}`
        : `Tirou o tipo do contato${contactName ? ` '${contactName}'` : ""}`,
      severity: "medium",
      createdAt: now,
    });
  }

  await scheduleWebhookEvent(ctx, {
    organizationId: contact.organizationId,
    event: "contact.updated",
    payload: {
      contactId: contact._id,
      changes: { relation },
      previous: { relation: previous },
      source,
    },
  });

  return result;
}
