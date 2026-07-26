/**
 * Reset de teste via WhatsApp: o comando "/resetme" enviado pelo PRÓPRIO
 * testador apaga (hard delete) contato + leads + conversas + histórico dele,
 * para re-testar o fluxo de primeira vez sem tocar no banco à mão.
 *
 * SEGURANÇA — três gates cumulativos:
 *  1. A env `WA_TEST_RESET_PHONES` ausente/vazia (default) = recurso
 *     INEXISTENTE em produção; nada é interceptado.
 *  2. Só dispara quando o telefone do REMETENTE está na allowlist da env
 *     (lista separada por vírgula, comparação por dígitos).
 *  3. Comando exato "/resetme" (trim, case-insensitive).
 * Nunca exposto como tool de IA nem rota pública; a mutation é internal.
 *
 * O hook vive em conversations.internalReceiveMessage (cobre Meta e bridge):
 * a mensagem de comando NÃO é persistida e o reset roda agendado em seguida.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

function normalizePhone(p: string): string {
  return p.replace(/\D/g, "");
}

export function isResetCommand(content: string): boolean {
  return content.trim().toLowerCase() === "/resetme";
}

export function phoneAllowedForReset(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const raw = process.env.WA_TEST_RESET_PHONES ?? "";
  const allowed = raw
    .split(",")
    .map((s) => normalizePhone(s))
    .filter(Boolean);
  const normalized = normalizePhone(phone);
  return normalized.length > 0 && allowed.includes(normalized);
}

const QUEUE_STATUSES = ["pending", "processing", "done", "skipped", "failed"] as const;
const SCHEDULED_STATUSES = ["pending", "sent", "canceled", "failed"] as const;

export const internalHardResetByPhone = internalMutation({
  args: { organizationId: v.id("organizations"), phone: v.string() },
  returns: v.record(v.string(), v.number()),
  handler: async (ctx, args) => {
    const normalized = normalizePhone(args.phone);
    const deleted: Record<string, number> = {
      contacts: 0, leads: 0, conversations: 0, messages: 0, files: 0,
      activities: 0, handoffs: 0, tasks: 0, aiReplyQueue: 0,
      scheduledMessages: 0, agentRuns: 0,
    };

    // Contatos do número (phone OU whatsappNumber, por dígitos — org de teste é pequena)
    const contacts = (
      await ctx.db
        .query("contacts")
        .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
        .collect()
    ).filter(
      (c) =>
        (c.phone && normalizePhone(c.phone) === normalized) ||
        (c.whatsappNumber && normalizePhone(c.whatsappNumber) === normalized)
    );

    for (const contact of contacts) {
      const leads = (
        await ctx.db
          .query("leads")
          .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
          .collect()
      ).filter((l) => l.organizationId === args.organizationId);

      for (const lead of leads) {
        const conversations = await ctx.db
          .query("conversations")
          .withIndex("by_lead", (q) => q.eq("leadId", lead._id))
          .collect();

        for (const conversation of conversations) {
          const messages = await ctx.db
            .query("messages")
            .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
            .collect();
          for (const message of messages) {
            for (const fileId of message.attachments ?? []) {
              const file = await ctx.db.get(fileId);
              if (file) {
                try {
                  await ctx.storage.delete(file.storageId as never);
                } catch {
                  // blob já removido — segue
                }
                await ctx.db.delete(fileId);
                deleted.files++;
              }
            }
            await ctx.db.delete(message._id);
            deleted.messages++;
          }

          for (const status of QUEUE_STATUSES) {
            const items = await ctx.db
              .query("aiReplyQueue")
              .withIndex("by_conversation_and_status", (q) =>
                q.eq("conversationId", conversation._id).eq("status", status)
              )
              .collect();
            for (const item of items) {
              await ctx.db.delete(item._id);
              deleted.aiReplyQueue++;
            }
          }

          for (const status of SCHEDULED_STATUSES) {
            const rows = await ctx.db
              .query("scheduledMessages")
              .withIndex("by_conversation_and_status", (q) =>
                q.eq("conversationId", conversation._id).eq("status", status)
              )
              .collect();
            for (const row of rows) {
              if (row.status === "pending" && row.scheduledFunctionId) {
                await ctx.scheduler.cancel(row.scheduledFunctionId as never);
              }
              await ctx.db.delete(row._id);
              deleted.scheduledMessages++;
            }
          }

          const runs = await ctx.db
            .query("agentRuns")
            .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
            .collect();
          for (const run of runs) {
            await ctx.db.delete(run._id);
            deleted.agentRuns++;
          }

          await ctx.db.delete(conversation._id);
          deleted.conversations++;
        }

        const activities = await ctx.db
          .query("activities")
          .withIndex("by_lead", (q) => q.eq("leadId", lead._id))
          .collect();
        for (const a of activities) {
          await ctx.db.delete(a._id);
          deleted.activities++;
        }

        const handoffs = await ctx.db
          .query("handoffs")
          .withIndex("by_lead", (q) => q.eq("leadId", lead._id))
          .collect();
        for (const h of handoffs) {
          await ctx.db.delete(h._id);
          deleted.handoffs++;
        }

        const tasks = await ctx.db
          .query("tasks")
          .withIndex("by_lead", (q) => q.eq("leadId", lead._id))
          .collect();
        for (const t of tasks) {
          await ctx.db.delete(t._id);
          deleted.tasks++;
        }

        await ctx.db.delete(lead._id);
        deleted.leads++;
      }

      const contactTasks = await ctx.db
        .query("tasks")
        .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
        .collect();
      for (const t of contactTasks) {
        await ctx.db.delete(t._id);
        deleted.tasks++;
      }

      await ctx.db.delete(contact._id);
      deleted.contacts++;
    }

    console.log(`[testReset] hard reset ${normalized}:`, JSON.stringify(deleted));
    return deleted;
  },
});
