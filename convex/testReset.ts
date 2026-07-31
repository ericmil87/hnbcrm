/**
 * Comandos de teste via WhatsApp. Três, todos sob os MESMOS gates:
 *  - "/resetme"            → hard delete do contato/leads/conversas do próprio
 *                            remetente, para re-testar o fluxo de primeira vez.
 *  - "/resetlist"          → responde no WhatsApp com os leads mais recentes da
 *                            org, numerados (insumo do /resetother).
 *  - "/resetother <arg>"   → hard delete de OUTRO lead, escolhido pelo número da
 *                            lista (1-2 dígitos) ou pelo sufixo do telefone (4+).
 *
 * SEGURANÇA — três gates cumulativos:
 *  1. A env `WA_TEST_RESET_PHONES` ausente/vazia (default) = recurso
 *     INEXISTENTE em produção; nada é interceptado.
 *  2. Só dispara quando o telefone do REMETENTE está na allowlist da env
 *     (lista separada por vírgula, comparação por dígitos).
 *  3. Comando exato (trim, case-insensitive).
 * Nunca exposto como tool de IA nem rota pública; as mutations são internal.
 *
 * O hook vive em conversations.internalReceiveMessage (cobre Meta e bridge):
 * a mensagem de comando NÃO é persistida e o trabalho roda agendado em seguida.
 */
import { v } from "convex/values";
import { internalMutation, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { applyOutboundMessageSideEffects } from "./lib/outboundSideEffects";

function normalizePhone(p: string): string {
  return p.replace(/\D/g, "");
}

export type TestCommand =
  | { kind: "resetme" }
  | { kind: "resetlist" }
  | { kind: "resetother"; arg: string };

// Comando exato no começo da mensagem; o resto (só o /resetother usa) é o
// argumento cru. Qualquer outra coisa não é comando — segue como mensagem.
export function parseTestCommand(content: string): TestCommand | null {
  const trimmed = content.trim();
  const [head, ...rest] = trimmed.split(/\s+/);
  const command = head?.toLowerCase();
  const arg = rest.join(" ").trim();

  if (command === "/resetme" && arg === "") return { kind: "resetme" };
  if (command === "/resetlist" && arg === "") return { kind: "resetlist" };
  if (command === "/resetother") return { kind: "resetother", arg };
  return null;
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
  handler: async (ctx, args) => await hardResetByPhone(ctx, args.organizationId, args.phone),
});

// O hard delete em si. Função pura de ctx (não mutation) porque o /resetother
// precisa das CONTAGENS na mesma transação para confirmar no WhatsApp — o
// /resetme continua chegando aqui pela mutation agendada acima.
async function hardResetByPhone(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  phone: string
): Promise<Record<string, number>> {
  const normalized = normalizePhone(phone);
  const deleted: Record<string, number> = {
    contacts: 0, leads: 0, conversations: 0, messages: 0, files: 0,
    activities: 0, handoffs: 0, tasks: 0, aiReplyQueue: 0,
    scheduledMessages: 0, agentRuns: 0,
  };

  // Contatos do número (phone OU whatsappNumber, por dígitos — org de teste é pequena)
  const contacts = (
    await ctx.db
      .query("contacts")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
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
    ).filter((l) => l.organizationId === organizationId);

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
}

// ── /resetlist e /resetother ──────────────────────────────────────────────────

const RESET_LIST_SIZE = 10;
const USAGE =
  "Uso: /resetother <nº da lista> ou /resetother <últimos 4+ dígitos do telefone>. " +
  "Veja os números com /resetlist.";

type ResetCandidate = { name: string; phone: string | null };

// Últimos dígitos, para exibir sem soletrar o número inteiro no WhatsApp.
function tail(phone: string, size: number): string {
  return phone.length <= size ? phone : phone.slice(-size);
}

// Candidatos na MESMA ordem determinística nos dois comandos (mais novo
// primeiro). O /resetother recalcula a lista na hora: se um lead novo chegar
// entre o /resetlist e o /resetother, os números saem do lugar. Risco aceito —
// isto só existe em org de teste, com allowlist de telefone.
async function collectResetCandidates(
  ctx: MutationCtx,
  organizationId: Id<"organizations">
): Promise<ResetCandidate[]> {
  const leads = await ctx.db
    .query("leads")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .order("desc")
    .collect();

  const candidates: ResetCandidate[] = [];
  for (const lead of leads) {
    const contact = lead.contactId ? await ctx.db.get(lead.contactId) : null;
    const name =
      [contact?.firstName, contact?.lastName].filter(Boolean).join(" ").trim() || lead.title;
    const phone = normalizePhone(contact?.whatsappNumber ?? contact?.phone ?? "");
    candidates.push({ name, phone: phone.length > 0 ? phone : null });
  }
  return candidates;
}

function formatResetList(candidates: ResetCandidate[]): string {
  const page = candidates.slice(0, RESET_LIST_SIZE);
  if (page.length === 0) return "Nenhum lead nesta organização.";

  const linhas = page.map((c, i) =>
    c.phone
      ? `${i + 1}. ${c.name} — …${tail(c.phone, 4)}`
      : `${i + 1}. ${c.name} (sem telefone — não resetável)`
  );
  return [
    `Leads mais recentes (${page.length}):`,
    ...linhas,
    "",
    "Para resetar: /resetother <nº da lista> ou /resetother <últimos 4+ dígitos do telefone>",
  ].join("\n");
}

// Resolve o alvo do /resetother: 1-2 dígitos = índice da lista; 4+ dígitos =
// sufixo do telefone. Ambiguidade NUNCA reseta — pede mais dígitos.
function resolveResetTarget(
  candidates: ResetCandidate[],
  arg: string
): { ok: true; target: ResetCandidate } | { ok: false; message: string } {
  const digits = normalizePhone(arg);
  if (digits.length === 0 || digits.length === 3 || digits.length > 15) {
    return { ok: false, message: USAGE };
  }

  if (digits.length <= 2) {
    const index = Number(digits);
    const target = candidates.slice(0, RESET_LIST_SIZE)[index - 1];
    if (index < 1 || !target) {
      return { ok: false, message: `Não existe o nº ${index} na lista. Veja com /resetlist.` };
    }
    if (!target.phone) {
      return { ok: false, message: `${target.name} não tem telefone — não dá para resetar.` };
    }
    return { ok: true, target };
  }

  // Sufixo: casa por telefone (não por lead) — vários leads do mesmo número são
  // um alvo só, já que o hard delete é por telefone.
  const byPhone = new Map<string, ResetCandidate>();
  for (const c of candidates) {
    if (c.phone && c.phone.endsWith(digits) && !byPhone.has(c.phone)) byPhone.set(c.phone, c);
  }
  const matches = [...byPhone.values()];
  if (matches.length === 0) {
    return { ok: false, message: `Nenhum lead com telefone terminando em ${digits}.` };
  }
  if (matches.length > 1) {
    const amostra = matches
      .map((m) => `${m.name} (…${tail(m.phone!, digits.length + 4)})`)
      .join(", ");
    return {
      ok: false,
      message: `${matches.length} leads terminam em ${digits}: ${amostra}. Use mais dígitos.`,
    };
  }
  return { ok: true, target: matches[0] };
}

// Autor da resposta: um humano da org (admin de preferência) — nunca o membro
// IA, cuja mensagem contaria como resposta do atendente nos tetos por conversa.
async function pickReplyAuthor(
  ctx: MutationCtx,
  organizationId: Id<"organizations">
): Promise<Doc<"teamMembers"> | null> {
  const humans = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) =>
      q.eq("organizationId", organizationId).eq("type", "human")
    )
    .collect();
  const active = humans.filter((m) => m.status === "active");
  return active.find((m) => m.role === "admin") ?? active[0] ?? null;
}

// Responde na conversa por onde o comando chegou, pelo caminho normal de
// outbound (side effects + dispatch pelo provider da conversa).
async function replyToCommand(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  text: string
): Promise<void> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation) return; // conversa sumiu (ex.: o próprio reset a apagou)
  const author = await pickReplyAuthor(ctx, conversation.organizationId);
  if (!author) {
    console.warn("[testReset] org sem membro humano ativo — resposta não enviada");
    return;
  }

  const now = Date.now();
  const messageId = await ctx.db.insert("messages", {
    organizationId: conversation.organizationId,
    conversationId,
    leadId: conversation.leadId,
    direction: "outbound",
    senderId: author._id,
    senderType: author.type === "ai" ? "ai" : "human",
    content: text,
    contentType: "text",
    isInternal: false,
    metadata: { testCommand: true },
    createdAt: now,
  });
  await applyOutboundMessageSideEffects(ctx, {
    conversation,
    member: author,
    messageId,
    now,
    activityContent: "Resposta de comando de teste via whatsapp",
  });
}

// Executa /resetlist ou /resetother e responde ao remetente. Agendada pelo hook
// do ingest, que já validou os três gates (env + allowlist + comando exato).
export const internalRunTestCommand = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    conversationId: v.id("conversations"),
    senderPhone: v.string(),
    command: v.union(v.literal("resetlist"), v.literal("resetother")),
    arg: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const candidates = await collectResetCandidates(ctx, args.organizationId);

    if (args.command === "resetlist") {
      await replyToCommand(ctx, args.conversationId, formatResetList(candidates));
      return null;
    }

    const resolved = resolveResetTarget(candidates, args.arg);
    if (!resolved.ok) {
      await replyToCommand(ctx, args.conversationId, resolved.message);
      return null;
    }

    const phone = resolved.target.phone!;
    if (phone === normalizePhone(args.senderPhone)) {
      // Apagar a si mesmo pelo /resetother levaria junto a conversa que
      // responderia a confirmação — o /resetme existe justamente para isso.
      await replyToCommand(
        ctx,
        args.conversationId,
        "Esse é o seu próprio número — use /resetme."
      );
      return null;
    }

    const deleted = await hardResetByPhone(ctx, args.organizationId, phone);
    const total = Object.values(deleted).reduce((sum, n) => sum + n, 0);
    await replyToCommand(
      ctx,
      args.conversationId,
      `Resetado: ${resolved.target.name} (…${tail(phone, 4)}) — ${total} documentos apagados`
    );
    return null;
  },
});
