/**
 * Contexto de CAMPANHA para o atendente IA: se a conversa recebeu uma mensagem
 * de campanha nos últimos 7 dias, a IA precisa saber — a resposta do contato é
 * REAÇÃO a um disparo ativo da empresa, não uma conversa que ele começou.
 *
 * O bloco entra no envelope NÃO-confiável (`<crm_data untrusted>`), porque o
 * texto renderizado da variante pode conter dado de destinatário (vars) e
 * nunca deve ser tratado como instrução.
 */
import { Doc } from "../_generated/dataModel";
import { QueryCtx, MutationCtx } from "../_generated/server";
import { CAMPAIGN_REPLY_WINDOW_MS } from "./campaignHooks";

const RELEVANT = new Set(["sent", "delivered", "read", "replied"]);

export function formatCampaignContext(args: {
  campaignName: string;
  sentAt: number;
  text: string;
  timezone?: string;
}): string {
  let date: string;
  try {
    date = new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      timeZone: args.timezone ?? "America/Sao_Paulo",
    }).format(new Date(args.sentAt));
  } catch {
    date = new Date(args.sentAt).toISOString().slice(5, 10).split("-").reverse().join("/");
  }
  const text = args.text.length > 600 ? `${args.text.slice(0, 600)}…` : args.text;
  return `CONTEXTO DE CAMPANHA: este contato recebeu a campanha «${args.campaignName}» em ${date} com o texto: «${text}». A mensagem dele é reação a esse disparo — retome o assunto naturalmente.`;
}

/** String pronta para o prompt, ou null quando a conversa não veio de campanha. */
export async function campaignContextForConversation(
  ctx: QueryCtx | MutationCtx,
  conversation: Doc<"conversations">,
  now: number,
  timezone?: string
): Promise<string | null> {
  const rows = await ctx.db
    .query("campaignRecipients")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
    .order("desc")
    .take(5);
  const recipient = rows.find(
    (r) =>
      r.organizationId === conversation.organizationId &&
      RELEVANT.has(r.status) &&
      (r.sentAt ?? r.createdAt) >= now - CAMPAIGN_REPLY_WINDOW_MS
  );
  if (!recipient) return null;
  const campaign = await ctx.db.get(recipient.campaignId);
  if (!campaign || campaign.organizationId !== conversation.organizationId) return null;
  let text = "";
  if (recipient.messageId) {
    const message = await ctx.db.get(recipient.messageId);
    if (message?.content) text = message.content;
  }
  if (!text) {
    const variant = campaign.content.variants[recipient.variantIndex ?? 0] ?? campaign.content.variants[0];
    text = campaign.content.template?.bodyText ?? variant?.text ?? "";
  }
  return formatCampaignContext({
    campaignName: campaign.name,
    sentAt: recipient.sentAt ?? recipient.createdAt,
    text,
    timezone,
  });
}
