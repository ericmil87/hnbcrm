/**
 * Guarda única de "dá para publicar nesta sala?" (review de correção nº 2).
 *
 * `POST /api/v1/groups/send` já checava tudo isto em
 * `groupsInternal.internalResolveGroupConversation`, mas os outros caminhos de
 * envio — `conversations.sendMessage` (app), `conversations.internalSendMessage`
 * (REST/MCP `POST /conversations/send`), `conversations.forwardMessage` e
 * `scheduledMessages.schedule`/`deliver` — recebiam um `conversationId` e
 * escreviam sem perguntar nada. Uma conversa de grupo não é apagada quando
 * alguém clica "Parar de acompanhar": ela é ARQUIVADA, com o mesmo `_id`. Quem
 * ainda tivesse aquele id na mão publicava numa sala com dezenas de pessoas de
 * fora — inclusive de um grupo do qual o número já saiu.
 *
 * Vive em `lib/` porque `conversations.ts` e `scheduledMessages.ts` precisam do
 * MESMO núcleo e `groupsInternal.ts` importa `groupChats.ts`: pendurar a guarda
 * lá criaria ciclo de módulos.
 *
 * Conversa 1 a 1 passa reta — a função é no-op fora de `kind: "group"`.
 */
import { Doc } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";

/**
 * Lança com mensagem em PT-BR quando a sala não aceita mais envio do CRM.
 * Os quatro motivos são distintos de propósito: quem vê o erro precisa saber se
 * desmarcou o acompanhamento, se saiu do grupo ou se desligou os grupos no
 * número.
 */
export async function assertGroupConversationSendable(
  ctx: { db: QueryCtx["db"] },
  conversation: Doc<"conversations">
): Promise<void> {
  if (conversation.kind !== "group") return;

  if (!conversation.groupChatId) {
    throw new Error("Conversa de grupo sem sala vinculada");
  }
  const group = await ctx.db.get(conversation.groupChatId);
  if (!group || group.organizationId !== conversation.organizationId) {
    throw new Error("Grupo não encontrado");
  }
  if (group.monitored !== true || group.conversationId === undefined) {
    throw new Error("Acompanhe o grupo antes de enviar mensagens nele");
  }
  if (group.leftAt !== undefined || group.removedAt !== undefined) {
    throw new Error("O número não faz mais parte deste grupo");
  }
  const config = await ctx.db.get(group.channelConfigId);
  if (!config || config.organizationId !== conversation.organizationId) {
    throw new Error("Canal do grupo não encontrado");
  }
  if (config.bridgeGroupsEnabled !== true) {
    throw new Error("Os grupos estão desligados neste número");
  }
}

/**
 * Menções válidas de uma sala: o JID só sai para o gateway se casar com alguém
 * que está DENTRO do grupo (review de segurança nº 4). O caminho da IA já fazia
 * isso em `lib/groupAgentCore.ts` (`resolveMentionJids`); o caminho humano
 * aceitava qualquer string e a punha em `ContextInfo.MentionedJID`, o que
 * transforma o número da empresa em notificador de terceiro.
 *
 * Casa por LID, por telefone e pelo "usuário" antes do `@` — é assim que o
 * painel de membros conhece as chaves, e é assim que o WhatsApp devolve.
 */
export function filterMentionsToParticipants(
  participants: Doc<"groupChats">["participants"],
  mentions: string[] | undefined
): string[] {
  if (!mentions || mentions.length === 0) return [];
  const known = new Set<string>();
  for (const p of participants ?? []) {
    if (p.leftAt !== undefined) continue;
    if (p.lid) {
      known.add(p.lid);
      known.add(p.lid.split("@")[0]);
    }
    if (p.phone) {
      known.add(p.phone);
      known.add(`${p.phone}@s.whatsapp.net`);
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of mentions) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    const user = raw.split("@")[0].split(":")[0].split(".")[0];
    if (!known.has(raw) && !known.has(user) && !known.has(user.replace(/\D/g, ""))) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/**
 * `filterMentionsToParticipants` a partir da CONVERSA: busca o doc da sala e
 * aplica o filtro. Devolve `undefined` quando não sobra nada (o campo
 * `messages.mentions` é opcional).
 */
export async function resolveGroupMentions(
  ctx: { db: QueryCtx["db"] },
  conversation: Doc<"conversations">,
  mentions: string[] | undefined
): Promise<string[] | undefined> {
  if (conversation.kind !== "group" || !mentions || mentions.length === 0) return undefined;
  if (!conversation.groupChatId) return undefined;
  const group = await ctx.db.get(conversation.groupChatId);
  if (!group) return undefined;
  // O teto estrutural do WhatsApp (1024 membros) continua valendo — a lista de
  // participantes já é capada em `GROUP_PARTICIPANTS_CAP`.
  const filtered = filterMentionsToParticipants(group.participants, mentions).slice(0, 1024);
  return filtered.length > 0 ? filtered : undefined;
}
