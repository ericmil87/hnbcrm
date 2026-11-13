/**
 * Estado da IA por conversa para a LISTA e o cabeçalho do inbox (fonte única).
 *
 * Função pura, só com dados que `getConversations` já tem em mãos (conversa,
 * lead, contato) mais UMA leitura fixa por execução (doc da org e membros IA).
 * Espelha as condições ESTÁVEIS de `evaluateEligibility` (attendant.ts) e de
 * `findAttendantForConversation`; as transitórias (horário, tetos, janela de
 * 24 h, standby) ficam de fora de propósito: viram o chip "IA em espera" no
 * cabeçalho, não "IA desligada".
 *
 * Pausa: query não lê o relógio. Sem `now`, só a pausa INDEFINIDA
 * (`Number.MAX_SAFE_INTEGER`, a de "Assumir conversa"/repasse aceito 1 a 1)
 * conta; com `now` (o cliente), vale `aiPausedUntil > now` como no cabeçalho.
 */
import type { Doc } from "../_generated/dataModel";
import { modulesOf } from "./orgModules";

export type ConversationAiMode = "auto" | "suggest" | "off";

export type AiModeOrg = {
  settings?: {
    aiConfig?: {
      enabled?: boolean;
      lgpdAck?: unknown;
      attendantEnabled?: boolean;
      groupAgentEnabled?: boolean;
      bridgeAiAck?: unknown;
    };
  };
} | null;

type AiMember = Pick<Doc<"teamMembers">, "_id" | "status" | "agentProfile">;

export function isAiPaused(aiPausedUntil: number | undefined, now?: number): boolean {
  if (aiPausedUntil === undefined) return false;
  if (now === undefined) return aiPausedUntil >= Number.MAX_SAFE_INTEGER;
  return aiPausedUntil > now;
}

/** Primeiro atendente ativo que cobre canal (config) e funil do lead (mesma regra de `findAttendantForConversation`). */
export function pickAttendantFor(
  members: AiMember[],
  conversation: { channelConfigId?: Doc<"conversations">["channelConfigId"] },
  lead: { boardId?: Doc<"leads">["boardId"] } | null
): AiMember | null {
  for (const member of members) {
    const profile = member.agentProfile;
    if (member.status !== "active" || profile?.kind !== "attendant") continue;
    if (
      profile.channelConfigIds &&
      profile.channelConfigIds.length > 0 &&
      (!conversation.channelConfigId || !profile.channelConfigIds.includes(conversation.channelConfigId))
    ) {
      continue;
    }
    if (lead && profile.boardIds && profile.boardIds.length > 0 && !profile.boardIds.includes(lead.boardId as any)) {
      continue;
    }
    return member;
  }
  return null;
}

export function conversationAiMode(input: {
  org: AiModeOrg;
  aiMembers: AiMember[];
  conversation: Pick<
    Doc<"conversations">,
    "kind" | "channel" | "channelConfigId" | "channelProvider" | "aiPausedUntil" | "botSuspicion"
  >;
  lead: Pick<Doc<"leads">, "boardId" | "assignedTo" | "handoffState"> | null;
  contact: { aiOptOut?: boolean } | null;
  now?: number;
}): ConversationAiMode {
  const { org, conversation, lead, contact } = input;
  const cfg = org?.settings?.aiConfig;
  // orgAiActive: enabled + aceite LGPD.
  if (!cfg || cfg.enabled !== true || cfg.lgpdAck === undefined) return "off";
  if (isAiPaused(conversation.aiPausedUntil, input.now)) return "off";

  // Sala de grupo: aqui só se sabe o "desligado" (flag da org, undefined = OFF).
  // Com a flag ligada o agente de grupo ainda depende do doc do grupo
  // (monitorado, modo menção, aceites) e só responde quando é mencionado: isso
  // a lista não lê. Por isso a linha da lista usa `listAiMode`, que devolve
  // `null` para grupo (sem indicador e fora do filtro de IA).
  if (conversation.kind === "group") return cfg.groupAgentEnabled === true ? "auto" : "off";

  if (cfg.attendantEnabled === false) return "off";
  if (
    conversation.channel !== "whatsapp" &&
    conversation.channel !== "instagram" &&
    conversation.channel !== "messenger"
  ) {
    return "off";
  }
  // Instagram/Messenger só com o módulo da org ligado (a saúde da conexão da
  // Página e o `status` do número não são lidos aqui: leitura por conta).
  if (
    (conversation.channel === "instagram" || conversation.channel === "messenger") &&
    !modulesOf(org as Parameters<typeof modulesOf>[0]).metaMessaging
  ) {
    return "off";
  }
  if (conversation.channelProvider === "bridge" && cfg.bridgeAiAck === undefined) return "off";

  const agent = pickAttendantFor(input.aiMembers, conversation, lead);
  if (!agent || agent.agentProfile?.kind !== "attendant") return "off";

  if (lead?.handoffState && lead.handoffState.status !== "completed") return "off";
  if (conversation.botSuspicion && conversation.botSuspicion.clearedAt === undefined) return "off";
  if (lead?.assignedTo !== undefined && lead.assignedTo !== agent._id) return "off";
  if (contact?.aiOptOut === true) return "off";

  return agent.agentProfile.mode === "autopilot" ? "auto" : "suggest";
}

/**
 * Estado da IA para a LINHA da lista e para o filtro `ai`: igual a
 * `conversationAiMode` em conversa 1 a 1 e `null` em grupo (o agente de grupo
 * depende do doc do grupo, que a lista não lê; dizer "IA respondendo" em todo
 * grupo da org seria falso). `null` = sem indicador e fora dos dois lados do filtro.
 */
export function listAiMode(input: Parameters<typeof conversationAiMode>[0]): ConversationAiMode | null {
  if (input.conversation.kind === "group") return null;
  return conversationAiMode(input);
}
