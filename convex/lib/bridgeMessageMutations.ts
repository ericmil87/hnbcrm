/**
 * "Apagar para todos" e edição vindos do bridge (whatsmeow `protocolMessage`).
 *
 * O id da mensagem alvo vem dentro do payload que o REMETENTE montou, então não
 * basta achar a mensagem pelo `externalId`: um contato poderia mandar um REVOKE
 * apontando para a mensagem de outro contato da org (ou para a nossa). Antes de
 * mexer, conferimos que quem pediu PODE mexer naquela mensagem — mesma regra do
 * WhatsApp: só o autor apaga/edita; em grupo um ADMIN também apaga.
 *
 * Nunca apagamos a linha nem o conteúdo: o CRM guarda para auditoria, o front
 * esconde (`metadata.revoked`). Nada aqui mexe em unread/lastMessageAt nem
 * enfileira IA/transcrição.
 */
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { phoneLookupCandidates } from "./phone";

export const EDIT_PREVIOUS_CONTENT_MAX = 2000;
export const EDIT_CONTENT_MAX = 65536;

export interface BridgeMessageMutationArgs {
  organizationId: Id<"organizations">;
  channelConfigId?: Id<"channelConfigs">;
  targetExternalId: string;
  isGroup: boolean;
  fromMe: boolean;
  chatPhone?: string;
  groupJid?: string;
  senderLid?: string;
  senderPhone?: string;
  at: number;
}

type Verdict = { ok: true; message: Doc<"messages"> } | { ok: false; reason: string };

function digits(s: string | undefined | null): string {
  return (s ?? "").replace(/\D/g, "");
}

/** O autor (membro) da mensagem de grupo é quem pede? */
function isGroupAuthor(message: Doc<"messages">, args: BridgeMessageMutationArgs): boolean {
  if (args.senderLid && message.senderLid && message.senderLid === args.senderLid) return true;
  if (args.senderPhone && message.senderPhone && message.senderPhone === args.senderPhone) return true;
  return false;
}

async function isGroupAdmin(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  args: BridgeMessageMutationArgs
): Promise<boolean> {
  if (!conversation.channelConfigId || !args.groupJid) return false;
  const group = await ctx.db
    .query("groupChats")
    .withIndex("by_channel_config_and_jid", (q) =>
      q.eq("channelConfigId", conversation.channelConfigId!).eq("jid", args.groupJid!)
    )
    .first();
  for (const p of group?.participants ?? []) {
    const same =
      (!!args.senderLid && p.lid === args.senderLid) ||
      (!!args.senderPhone && p.phone === args.senderPhone);
    if (same) return p.isAdmin || p.isSuperAdmin;
  }
  return false;
}

async function resolveTarget(
  ctx: MutationCtx,
  args: BridgeMessageMutationArgs,
  action: "revoke" | "edit"
): Promise<Verdict> {
  const message = await ctx.db
    .query("messages")
    .withIndex("by_organization_and_external_id", (q) =>
      q.eq("organizationId", args.organizationId).eq("externalId", args.targetExternalId)
    )
    .first();
  if (!message) return { ok: false, reason: "alvo_desconhecido" };
  const conversation = await ctx.db.get(message.conversationId);
  if (!conversation || conversation.organizationId !== args.organizationId) {
    return { ok: false, reason: "conversa_ausente" };
  }
  if (
    args.channelConfigId &&
    conversation.channelConfigId &&
    conversation.channelConfigId !== args.channelConfigId
  ) {
    return { ok: false, reason: "outro_canal" };
  }

  if (args.isGroup) {
    if (conversation.kind !== "group" || conversation.externalChatId !== args.groupJid) {
      return { ok: false, reason: "outra_conversa" };
    }
    if (args.fromMe) {
      return message.direction === "outbound" ? { ok: true, message } : { ok: false, reason: "nao_e_nossa" };
    }
    if (message.direction === "inbound" && isGroupAuthor(message, args)) return { ok: true, message };
    // Admin da sala pode APAGAR a mensagem de outro membro (inclusive a nossa); editar, nunca.
    if (action === "revoke" && (await isGroupAdmin(ctx, conversation, args))) return { ok: true, message };
    return { ok: false, reason: "nao_e_autor" };
  }

  if (conversation.kind === "group") return { ok: false, reason: "outra_conversa" };
  if (args.fromMe) {
    return message.direction === "outbound" ? { ok: true, message } : { ok: false, reason: "nao_e_nossa" };
  }
  if (message.direction !== "inbound") return { ok: false, reason: "nao_e_autor" };
  // O contato da conversa precisa ser quem pediu (aceita as duas grafias do 9º dígito BR).
  const lead = conversation.leadId ? await ctx.db.get(conversation.leadId) : null;
  const contact = lead?.contactId ? await ctx.db.get(lead.contactId) : null;
  const known = [digits(contact?.whatsappNumber), digits(contact?.phone)].filter((d) => d.length > 0);
  const candidates = phoneLookupCandidates(digits(args.chatPhone));
  if (!known.some((k) => candidates.includes(k))) return { ok: false, reason: "nao_e_autor" };
  return { ok: true, message };
}

/** Marca a mensagem como apagada para todos. Devolve o id ou null (ignorado). */
export async function applyBridgeRevoke(
  ctx: MutationCtx,
  args: BridgeMessageMutationArgs
): Promise<Id<"messages"> | null> {
  const verdict = await resolveTarget(ctx, args, "revoke");
  if (!verdict.ok) {
    if (verdict.reason !== "alvo_desconhecido") {
      console.warn(`Bridge revoke recusado (${verdict.reason}) para ${args.targetExternalId}`);
    }
    return null;
  }
  const { message } = verdict;
  if (message.metadata?.revoked === true) return message._id;
  await ctx.db.patch(message._id, {
    metadata: { ...(message.metadata ?? {}), revoked: true, revokedAt: args.at },
  });
  return message._id;
}

/** Troca o conteúdo pela versão editada, guardando o PRIMEIRO conteúdo original. */
export async function applyBridgeEdit(
  ctx: MutationCtx,
  args: BridgeMessageMutationArgs & { newContent: string }
): Promise<Id<"messages"> | null> {
  const newContent = args.newContent.slice(0, EDIT_CONTENT_MAX);
  if (newContent.trim().length === 0) return null;
  const verdict = await resolveTarget(ctx, args, "edit");
  if (!verdict.ok) {
    if (verdict.reason !== "alvo_desconhecido") {
      console.warn(`Bridge edit recusado (${verdict.reason}) para ${args.targetExternalId}`);
    }
    return null;
  }
  const { message } = verdict;
  if (message.content === newContent) return message._id;
  const prior = message.metadata?.previousContent;
  const previousContent =
    typeof prior === "string" ? prior : message.content.slice(0, EDIT_PREVIOUS_CONTENT_MAX);
  await ctx.db.patch(message._id, {
    content: newContent,
    metadata: { ...(message.metadata ?? {}), edited: true, editedAt: args.at, previousContent },
  });
  return message._id;
}
