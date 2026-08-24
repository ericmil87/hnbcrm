/**
 * Exclusão definitiva de lead — núcleo compartilhado por `leads.deleteLead`,
 * `leads.bulkDeleteLeads`, `leads.internalDeleteLead` (REST), a confirmação do
 * copiloto e a cascata de `boards.deleteBoard`.
 *
 * Duas metades:
 *  1. CABEÇA (síncrona, `hardDeleteLead`): audit log com SNAPSHOT completo do
 *     doc (fica consultável em Auditoria — o viewer expande `changes.before`),
 *     webhook `lead.deleted` e delete do doc do lead. Barata o bastante para
 *     rodar em lote (bulk de 100) dentro de uma mutation.
 *  2. CASCATA (batched, agendada): filhos do lead — conversas (+ mensagens,
 *     blobs, fila da IA, agendamentos), repasses, atividades e documentos — e
 *     limpeza das referências opcionais (tasks/eventos/arquivos). Roda com
 *     orçamento de escritas por execução e o job se RE-AGENDA até exaurir
 *     (um job sequencial, nunca N jobs por lead).
 *
 * Contatos: só saem junto quando pedido explicitamente E o contato não tem mais
 * nenhum lead depois desta exclusão (snapshot em audit log, igual ao lead).
 */
import { v } from "convex/values";
import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { buildAuditDescription } from "./auditDescription";

// Escritas por execução do job. Convex aceita muito mais por transação; o teto
// baixo mantém cada execução curta e o re-agendamento previsível.
export const CASCADE_WRITE_BUDGET = 150;

const QUEUE_STATUSES = ["pending", "processing", "done", "skipped", "failed"] as const;
const SCHEDULED_STATUSES = ["pending", "sent", "canceled", "failed"] as const;

export const actorTypeValidator = v.union(
  v.literal("human"),
  v.literal("ai"),
  v.literal("system")
);

export type CascadeActorType = "human" | "ai" | "system";

export type WriteBudget = { left: number };

export function newBudget(left: number = CASCADE_WRITE_BUDGET): WriteBudget {
  return { left };
}

/**
 * Snapshot de um doc para `auditLogs.changes.before`.
 * O viewer (src/components/AuditLogs.tsx) monta uma tabela campo→valor, então
 * escalares e listas de escalares vão crus e o resto vira JSON legível.
 * `_id`/`_creationTime` viram `id`/`creationTime` — o Convex rejeita nome de
 * campo começando com underscore.
 */
export function buildEntitySnapshot(doc: Record<string, any>): Record<string, any> {
  const snapshot: Record<string, any> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (value === undefined) continue;
    const field = key === "_id" ? "id" : key === "_creationTime" ? "creationTime" : key;
    if (field.startsWith("_")) continue;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      snapshot[field] = value;
    } else if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string" || typeof item === "number")
    ) {
      snapshot[field] = value;
    } else {
      snapshot[field] = JSON.stringify(value);
    }
  }
  return snapshot;
}

function contactDisplayName(contact: Doc<"contacts">): string {
  return (
    [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() ||
    contact.email ||
    contact.phone ||
    "Contato sem nome"
  );
}

async function deleteFileWithBlob(ctx: MutationCtx, fileId: Id<"files">): Promise<number> {
  const file = await ctx.db.get(fileId);
  if (!file) return 0;
  try {
    await ctx.storage.delete(file.storageId as never);
  } catch {
    // blob já removido — segue
  }
  await ctx.db.delete(fileId);
  return 1;
}

async function deleteConversation(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  budget: WriteBudget
): Promise<boolean> {
  while (budget.left > 0) {
    const page = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .take(Math.min(budget.left, 100));
    if (page.length === 0) break;
    for (const message of page) {
      for (const fileId of message.attachments ?? []) {
        budget.left -= await deleteFileWithBlob(ctx, fileId);
      }
      await ctx.db.delete(message._id);
      budget.left -= 1;
    }
  }
  if (budget.left <= 0) return false;

  for (const status of QUEUE_STATUSES) {
    const items = await ctx.db
      .query("aiReplyQueue")
      .withIndex("by_conversation_and_status", (q) =>
        q.eq("conversationId", conversationId).eq("status", status)
      )
      .take(Math.min(budget.left, 100));
    for (const item of items) {
      await ctx.db.delete(item._id);
      budget.left -= 1;
    }
    if (budget.left <= 0) return false;
  }

  for (const status of SCHEDULED_STATUSES) {
    const rows = await ctx.db
      .query("scheduledMessages")
      .withIndex("by_conversation_and_status", (q) =>
        q.eq("conversationId", conversationId).eq("status", status)
      )
      .take(Math.min(budget.left, 100));
    for (const row of rows) {
      if (row.status === "pending" && row.scheduledFunctionId) {
        await ctx.scheduler.cancel(row.scheduledFunctionId as never);
      }
      await ctx.db.delete(row._id);
      budget.left -= 1;
    }
    if (budget.left <= 0) return false;
  }

  await ctx.db.delete(conversationId);
  budget.left -= 1;
  return true;
}

/**
 * Filhos de um lead já excluído. Retorna `false` quando o orçamento acabou
 * antes de terminar — o chamador re-agenda com o mesmo leadId (as etapas são
 * idempotentes: o que já foi apagado não aparece na próxima varredura).
 */
export async function cascadeLeadChildren(
  ctx: MutationCtx,
  leadId: Id<"leads">,
  budget: WriteBudget
): Promise<boolean> {
  while (budget.left > 0) {
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_lead", (q) => q.eq("leadId", leadId))
      .first();
    if (!conversation) break;
    if (!(await deleteConversation(ctx, conversation._id, budget))) return false;
  }
  if (budget.left <= 0) return false;

  // Mensagens órfãs (conversa já apagada em execução anterior, mensagem não)
  while (budget.left > 0) {
    const page = await ctx.db
      .query("messages")
      .withIndex("by_lead", (q) => q.eq("leadId", leadId))
      .take(Math.min(budget.left, 100));
    if (page.length === 0) break;
    for (const message of page) {
      for (const fileId of message.attachments ?? []) {
        budget.left -= await deleteFileWithBlob(ctx, fileId);
      }
      await ctx.db.delete(message._id);
      budget.left -= 1;
    }
  }
  if (budget.left <= 0) return false;

  while (budget.left > 0) {
    const page = await ctx.db
      .query("handoffs")
      .withIndex("by_lead", (q) => q.eq("leadId", leadId))
      .take(Math.min(budget.left, 100));
    if (page.length === 0) break;
    for (const handoff of page) {
      await ctx.db.delete(handoff._id);
      budget.left -= 1;
    }
  }
  if (budget.left <= 0) return false;

  while (budget.left > 0) {
    const page = await ctx.db
      .query("activities")
      .withIndex("by_lead", (q) => q.eq("leadId", leadId))
      .take(Math.min(budget.left, 100));
    if (page.length === 0) break;
    for (const activity of page) {
      await ctx.db.delete(activity._id);
      budget.left -= 1;
    }
  }
  if (budget.left <= 0) return false;

  while (budget.left > 0) {
    const page = await ctx.db
      .query("leadDocuments")
      .withIndex("by_lead", (q) => q.eq("leadId", leadId))
      .take(Math.min(budget.left, 50));
    if (page.length === 0) break;
    for (const document of page) {
      budget.left -= await deleteFileWithBlob(ctx, document.fileId);
      await ctx.db.delete(document._id);
      budget.left -= 1;
    }
  }
  if (budget.left <= 0) return false;

  // Referências opcionais: o registro sobrevive, o vínculo some.
  while (budget.left > 0) {
    const page = await ctx.db
      .query("tasks")
      .withIndex("by_lead", (q) => q.eq("leadId", leadId))
      .take(Math.min(budget.left, 100));
    if (page.length === 0) break;
    for (const task of page) {
      await ctx.db.patch(task._id, { leadId: undefined });
      budget.left -= 1;
    }
  }
  if (budget.left <= 0) return false;

  while (budget.left > 0) {
    const page = await ctx.db
      .query("calendarEvents")
      .withIndex("by_lead", (q) => q.eq("leadId", leadId))
      .take(Math.min(budget.left, 100));
    if (page.length === 0) break;
    for (const event of page) {
      await ctx.db.patch(event._id, { leadId: undefined });
      budget.left -= 1;
    }
  }
  if (budget.left <= 0) return false;

  while (budget.left > 0) {
    const page = await ctx.db
      .query("files")
      .withIndex("by_lead", (q) => q.eq("leadId", leadId))
      .take(Math.min(budget.left, 100));
    if (page.length === 0) break;
    for (const file of page) {
      await ctx.db.patch(file._id, { leadId: undefined });
      budget.left -= 1;
    }
  }
  return budget.left > 0;
}

/**
 * Referências de um contato já excluído junto do lead. Mesma semântica de
 * retorno da cascata do lead.
 */
export async function cascadeContactRefs(
  ctx: MutationCtx,
  contactId: Id<"contacts">,
  budget: WriteBudget
): Promise<boolean> {
  while (budget.left > 0) {
    const page = await ctx.db
      .query("tasks")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .take(Math.min(budget.left, 100));
    if (page.length === 0) break;
    for (const task of page) {
      await ctx.db.patch(task._id, { contactId: undefined });
      budget.left -= 1;
    }
  }
  if (budget.left <= 0) return false;

  while (budget.left > 0) {
    const page = await ctx.db
      .query("calendarEvents")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .take(Math.min(budget.left, 100));
    if (page.length === 0) break;
    for (const event of page) {
      await ctx.db.patch(event._id, { contactId: undefined });
      budget.left -= 1;
    }
  }
  if (budget.left <= 0) return false;

  while (budget.left > 0) {
    const page = await ctx.db
      .query("files")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .take(Math.min(budget.left, 100));
    if (page.length === 0) break;
    for (const file of page) {
      if (file.fileType === "contact_photo") {
        budget.left -= await deleteFileWithBlob(ctx, file._id);
      } else {
        await ctx.db.patch(file._id, { contactId: undefined });
        budget.left -= 1;
      }
    }
  }
  return budget.left > 0;
}

/**
 * Cabeça da exclusão: audit com snapshot, webhook e delete do doc. A cascata
 * dos filhos é responsabilidade do chamador (ver `scheduleLeadCascade`).
 * Devolve o contato excluído junto, quando houver.
 */
export async function hardDeleteLead(
  ctx: MutationCtx,
  args: {
    lead: Doc<"leads">;
    actorId?: Id<"teamMembers">;
    actorType: CascadeActorType;
    deleteContact?: boolean;
    description?: string;
    extraMetadata?: Record<string, any>;
  }
): Promise<{ deletedContactId: Id<"contacts"> | null }> {
  const { lead } = args;
  const now = Date.now();
  const metadata = {
    title: lead.title,
    boardId: lead.boardId,
    contactId: lead.contactId,
    deleteContact: args.deleteContact === true,
    ...(args.extraMetadata ?? {}),
  };

  await ctx.db.insert("auditLogs", {
    organizationId: lead.organizationId,
    entityType: "lead",
    entityId: lead._id,
    action: "delete",
    actorId: args.actorId,
    actorType: args.actorType,
    changes: { before: buildEntitySnapshot(lead) },
    metadata,
    description:
      args.description ??
      buildAuditDescription({ action: "delete", entityType: "lead", metadata }),
    severity: "high",
    createdAt: now,
  });

  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId: lead.organizationId,
    event: "lead.deleted",
    payload: { leadId: lead._id, title: lead.title, boardId: lead.boardId },
  });

  await ctx.db.delete(lead._id);

  if (!args.deleteContact || !lead.contactId) return { deletedContactId: null };

  const contact = await ctx.db.get(lead.contactId);
  if (!contact || contact.organizationId !== lead.organizationId) {
    return { deletedContactId: null };
  }

  const remainingLead = await ctx.db
    .query("leads")
    .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
    .first();
  // Contato com outro lead fica — sem erro, é o caso normal do bulk.
  if (remainingLead) return { deletedContactId: null };

  const name = contactDisplayName(contact);
  await ctx.db.insert("auditLogs", {
    organizationId: contact.organizationId,
    entityType: "contact",
    entityId: contact._id,
    action: "delete",
    actorId: args.actorId,
    actorType: args.actorType,
    changes: { before: buildEntitySnapshot(contact) },
    metadata: { name, email: contact.email, viaLeadId: lead._id },
    description: `Excluiu o contato '${name}' junto do lead '${lead.title}'`,
    severity: "high",
    createdAt: now,
  });
  await ctx.db.delete(contact._id);

  return { deletedContactId: contact._id };
}

/** Agenda UM job sequencial para os filhos de todos os leads/contatos do lote. */
export async function scheduleLeadCascade(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    leadIds: Id<"leads">[];
    contactIds: Id<"contacts">[];
  }
): Promise<void> {
  if (args.leadIds.length === 0 && args.contactIds.length === 0) return;
  await ctx.scheduler.runAfter(0, internal.leads.internalCascadeDeleteLeads, {
    organizationId: args.organizationId,
    leadIds: args.leadIds,
    contactIds: args.contactIds,
  });
}
