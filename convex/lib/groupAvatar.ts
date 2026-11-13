/**
 * Foto de perfil do GRUPO (bridge) — regras PURAS. Vencimento, ritmo e teto são os
 * do contato (`lib/contactAvatar.ts`); aqui só o que é de grupo:
 *  - elegibilidade: sala acompanhada, ativa (sem `removedAt`/`leftAt`), JID `@g.us`,
 *    conversa não arquivada;
 *  - o ingest decide pelo CARIMBO `groupChats.avatarNextCheckAt` (o doc do grupo já
 *    está lido), sem abrir a linha lateral `groupAvatars`;
 *  - `conversations.groupAvatarUrl` (o que a lista lê) só escreve quando a URL muda.
 */
import { contactAvatarFetchEnabled } from "./contactAvatar";

export type GroupAvatarGroup = {
  organizationId: string;
  monitored: boolean;
  conversationId?: string;
  removedAt?: number;
  leftAt?: number;
  jid: string;
  avatarNextCheckAt?: number;
};

/** Sala que o CRM acompanha e onde seguimos presentes. */
export function groupAvatarEligible(
  group: GroupAvatarGroup,
  conversation?: { organizationId: string; archivedAt?: number } | null
): boolean {
  if (!contactAvatarFetchEnabled()) return false;
  if (!group.monitored || !group.conversationId) return false;
  if (group.removedAt !== undefined || group.leftAt !== undefined) return false;
  if (!group.jid.endsWith("@g.us")) return false;
  if (conversation && (conversation.organizationId !== group.organizationId || conversation.archivedAt)) {
    return false;
  }
  return true;
}

/** Carimbo vencido (ou nunca posto)? Decide o gatilho sem ler `groupAvatars`. */
export function groupAvatarStampDue(group: { avatarNextCheckAt?: number }, now: number): boolean {
  return group.avatarNextCheckAt === undefined || now >= group.avatarNextCheckAt;
}

/**
 * Fatia do teto diário do canal (`AVATAR_DAILY_CAP_PER_CHANNEL`, compartilhado com a foto
 * do contato) que a foto de GRUPO pode usar: com `dayCount` >= isto, buscas de grupo param
 * no dia e o resto fica para contatos.
 */
export const GROUP_AVATAR_DAILY_CAP = 100;
/** Grupos que cada execução do sync de grupos pode agendar para foto (o resto vem por mensagem/abertura/próximo sync). */
export const GROUP_AVATAR_SYNC_MAX_SCHEDULES = 5;

/** Recuo do carimbo quando o canal não pode buscar agora (teto/pausa/fila). */
export const GROUP_AVATAR_THROTTLE_STAMP_MS = 15 * 60_000;

/** Efeito de uma troca da foto na conversa: só escreve se a URL mudou. */
export function groupAvatarConversationPatch(
  currentUrl: string | undefined,
  nextUrl: string | undefined
): { write: boolean; groupAvatarUrl?: string } {
  if (currentUrl === nextUrl) return { write: false };
  return { write: true, groupAvatarUrl: nextUrl };
}
