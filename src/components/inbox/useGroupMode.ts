import React, { useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import type { GroupChatDoc } from "@/components/inbox/types";

/**
 * Modo "conversa de GRUPO" (v0.57): uma conversa de grupo NÃO tem lead nem
 * contato — tudo que depende deles (funil, "Ver lead", repasse, rascunho de IA)
 * sai da tela, e o que a substitui é a sala: assunto, membros e a política do
 * grupo. Aqui ficam o documento da sala e o nome por JID das menções.
 */
export function useGroupMode(
  currentConversation: Record<string, any> | null | undefined,
  messages: readonly unknown[] | null | undefined
) {
  const isGroupConversation = currentConversation?.kind === "group";
  const groupChatId = currentConversation?.groupChatId as Id<"groupChats"> | undefined;
  const groupChat = useQuery(
    api.groupChats.getGroup,
    isGroupConversation && groupChatId ? { groupChatId } : "skip"
  ) as (GroupChatDoc & { selfKey?: string | null }) | null | undefined;
  const groupSummary = currentConversation?.groupChat as
    | { subject: string; jid: string; participantsCount: number }
    | null
    | undefined;
  const groupSubject = groupChat?.subject ?? groupSummary?.subject ?? "Grupo";
  const groupParticipantsCount =
    groupChat?.participantsCount ?? groupSummary?.participantsCount ?? 0;

  // Nome por JID mencionado — alimenta o negrito das menções recebidas (o
  // corpo traz "@558…" ou "@Fulano", e os dois precisam casar). Perf (onda 2):
  // resolve só os JIDs que aparecem nas mensagens carregadas, em vez de baixar
  // a sala inteira (até 1.024 membros) pelo `getGroup`.
  const mentionedJids = React.useMemo(() => {
    if (!isGroupConversation || !messages) return [];
    const set = new Set<string>();
    for (const m of messages as { mentions?: string[] }[]) {
      for (const jid of m.mentions ?? []) if (typeof jid === "string" && jid) set.add(jid);
    }
    return Array.from(set).sort().slice(0, 100);
  }, [isGroupConversation, messages]);
  const mentionNames = useQuery(
    api.groupChats.resolveGroupMemberNames,
    isGroupConversation && groupChatId && mentionedJids.length > 0
      ? { groupChatId, jids: mentionedJids }
      : "skip"
  );
  // Último mapa carregado, para não piscar enquanto a próxima consulta volta —
  // zerado ao trocar de sala (senão os nomes de uma sala vazariam na outra).
  const lastMentionNames = useRef<{ jid: string; name: string }[]>([]);
  const lastMentionNamesGroup = useRef<string | undefined>(groupChatId);
  if (lastMentionNamesGroup.current !== groupChatId) {
    lastMentionNamesGroup.current = groupChatId;
    lastMentionNames.current = [];
  }
  if (mentionNames !== undefined) lastMentionNames.current = mentionNames;
  const groupNameByKey = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const { jid, name } of mentionNames ?? lastMentionNames.current) {
      map.set(jid, name);
      map.set(jid.split("@")[0], name);
    }
    return map;
  }, [mentionNames, groupChatId]);

  return {
    isGroupConversation,
    groupChatId,
    groupChat,
    groupSubject,
    groupParticipantsCount,
    groupNameByKey,
  };
}
