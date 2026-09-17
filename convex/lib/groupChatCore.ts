/**
 * Núcleo compartilhado dos grupos de WhatsApp (v0.57).
 *
 * Vive em `lib/` porque `conversations.ts` (ingest da mensagem) e
 * `groupChats.ts` (sincronização, monitorar, eventos de grupo) precisam dos
 * MESMOS helpers — importar um do outro criaria ciclo de módulos e degradaria
 * a inferência de tipos da API gerada.
 */
import { MutationCtx, QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { ParsedGroupInfo, findSelfParticipant, participantKey } from "./bridgeGroups";
import {
  PermissionCategory,
  Role,
  hasPermission,
  resolvePermissions,
} from "./permissions";

/** Teto da linha do tempo da sala (FIFO, mesmo padrão de `campaigns.timeline`). */
export const GROUP_TIMELINE_CAP = 100;
/** Teto de `messages.readBy` — num grupo grande o recibo chega por membro. */
export const GROUP_READ_BY_CAP = 50;
/** Teto duro de participantes guardados (limite estrutural do WhatsApp). */
export const GROUP_PARTICIPANTS_CAP = 1024;
/**
 * Tetos de nome e descrição da sala (review de segurança nº 8). Quem escolhe os
 * dois é um ADMIN DO GRUPO — um terceiro — e o valor viaja daqui para o prompt
 * da IA, a notificação, o card da UI e o payload do webhook. O conteúdo já é
 * tratado como não-confiável no prompt; o que faltava era teto de TAMANHO.
 * O WhatsApp limita a ~100 e ~512 caracteres; a folga cobre emoji multibyte.
 */
export const GROUP_SUBJECT_CAP = 200;
export const GROUP_TOPIC_CAP = 512;

export type GroupParticipantRow = NonNullable<Doc<"groupChats">["participants"]>[number];
export type GroupTimelineEntry = NonNullable<Doc<"groupChats">["timeline"]>[number];

/** Acrescenta um evento à linha do tempo da sala, respeitando o cap FIFO. */
export function appendTimeline(
  current: GroupTimelineEntry[] | undefined,
  entry: GroupTimelineEntry
): GroupTimelineEntry[] {
  const next = [...(current ?? []), entry];
  return next.length > GROUP_TIMELINE_CAP ? next.slice(next.length - GROUP_TIMELINE_CAP) : next;
}

/** Acrescenta/atualiza uma confirmação de leitura, respeitando o cap FIFO. */
export function appendReadBy(
  current: { jid: string; at: number }[] | undefined,
  jid: string,
  at: number
): { jid: string; at: number }[] {
  const without = (current ?? []).filter((r) => r.jid !== jid);
  const next = [...without, { jid, at }];
  return next.length > GROUP_READ_BY_CAP ? next.slice(next.length - GROUP_READ_BY_CAP) : next;
}

/**
 * Casa um participante pela chave estável (LID quando existe, senão telefone) e
 * devolve a lista NOVA com os campos informados mesclados. Nunca apaga o que já
 * se sabia: um evento que só traz o LID não pode zerar o telefone descoberto
 * numa sincronização anterior (e vice-versa).
 */
export function mergeParticipant(
  current: GroupParticipantRow[] | undefined,
  incoming: Partial<GroupParticipantRow> & { lid?: string; phone?: string }
): GroupParticipantRow[] {
  const key = incoming.lid ?? incoming.phone;
  if (!key) return current ?? [];
  const list = [...(current ?? [])];
  const index = list.findIndex(
    (p) => (incoming.lid && p.lid === incoming.lid) || (incoming.phone && p.phone === incoming.phone)
  );
  if (index === -1) {
    if (list.length >= GROUP_PARTICIPANTS_CAP) return list;
    list.push({
      ...(incoming.lid ? { lid: incoming.lid } : {}),
      ...(incoming.phone ? { phone: incoming.phone } : {}),
      ...(incoming.name ? { name: incoming.name } : {}),
      ...(incoming.contactId ? { contactId: incoming.contactId } : {}),
      ...(incoming.joinedAt ? { joinedAt: incoming.joinedAt } : {}),
      isAdmin: incoming.isAdmin === true,
      isSuperAdmin: incoming.isSuperAdmin === true,
    });
    return list;
  }
  const prev = list[index];
  list[index] = {
    ...prev,
    ...(incoming.lid ? { lid: incoming.lid } : {}),
    ...(incoming.phone ? { phone: incoming.phone } : {}),
    ...(incoming.name ? { name: incoming.name } : {}),
    ...(incoming.contactId ? { contactId: incoming.contactId } : {}),
    ...(incoming.joinedAt ? { joinedAt: incoming.joinedAt } : {}),
    ...(incoming.leftAt !== undefined ? { leftAt: incoming.leftAt } : {}),
    ...(incoming.isAdmin !== undefined ? { isAdmin: incoming.isAdmin } : {}),
    ...(incoming.isSuperAdmin !== undefined ? { isSuperAdmin: incoming.isSuperAdmin } : {}),
  };
  return list;
}

/**
 * Funde a lista vinda do gateway (`/group/list`) com a que já está gravada,
 * PRESERVANDO o que só o CRM sabe: nome do membro (vem do PushName das
 * mensagens, o gateway devolve `DisplayName` vazio) e o `contactId` resolvido.
 * Quem sumiu da lista do gateway ganha `leftAt` em vez de desaparecer.
 */
export function mergeParticipantsFromGateway(
  current: GroupParticipantRow[] | undefined,
  incoming: ParsedGroupInfo["participants"],
  now: number
): GroupParticipantRow[] {
  const known = new Map<string, GroupParticipantRow>();
  for (const p of current ?? []) {
    const key = participantKey(p);
    if (key) known.set(key, p);
  }

  const merged: GroupParticipantRow[] = [];
  const seen = new Set<string>();
  for (const p of incoming.slice(0, GROUP_PARTICIPANTS_CAP)) {
    const key = participantKey(p);
    if (!key) continue;
    seen.add(key);
    const prev = known.get(key) ?? (p.phone ? known.get(p.phone) : undefined);
    merged.push({
      ...(p.lid ? { lid: p.lid } : prev?.lid ? { lid: prev.lid } : {}),
      ...(p.phone ? { phone: p.phone } : prev?.phone ? { phone: prev.phone } : {}),
      // Nome do gateway quase sempre vem vazio — o do CRM vence.
      ...(prev?.name ? { name: prev.name } : p.name ? { name: p.name } : {}),
      ...(prev?.contactId ? { contactId: prev.contactId } : {}),
      ...(prev?.joinedAt ? { joinedAt: prev.joinedAt } : {}),
      isAdmin: p.isAdmin,
      isSuperAdmin: p.isSuperAdmin,
    });
  }

  // Quem estava e não veio: marca a saída, mas mantém a linha (o histórico de
  // mensagens dele continua no inbox e o nome ainda serve para exibir).
  for (const [key, prev] of known) {
    if (seen.has(key)) continue;
    merged.push({ ...prev, leftAt: prev.leftAt ?? now });
  }
  return merged.slice(0, GROUP_PARTICIPANTS_CAP);
}

/**
 * A lista de membros só é PERSISTIDA em sala acompanhada (review de segurança
 * nº 1, review de correção nº 4).
 *
 * O opt-in por grupo (D4) existe justamente porque o número da empresa está em
 * grupos que não são da empresa: família, escola, condomínio. Filtrar só o
 * CONTEÚDO das mensagens não bastava — a sincronização gravava nome e telefone
 * de TODOS os membros de TODAS as salas do número, e a lista saía no backup
 * JSON e em `getGroup` para qualquer um com `inbox:view_own`.
 *
 * Do grupo não acompanhado ficam só `subject`, a contagem e as flags. A
 * contagem vem do tamanho da lista do gateway (o `/group/list` do wuzapi
 * devolve `ParticipantCount: 0`), não da lista guardada.
 */
export function participantsForStorage(
  monitored: boolean | undefined,
  merged: GroupParticipantRow[]
): { participants: GroupParticipantRow[]; participantsCount: number } {
  if (monitored === true) {
    return {
      participants: merged,
      participantsCount: merged.filter((p) => p.leftAt === undefined).length,
    };
  }
  return { participants: [], participantsCount: merged.filter((p) => p.leftAt === undefined).length };
}

/**
 * Contato da org com este telefone, se existir. D3: membro de grupo NUNCA vira
 * contato automaticamente — só amarramos quando o telefone JÁ é conhecido.
 */
export async function findContactIdByPhone(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  phone: string | undefined
): Promise<Id<"contacts"> | undefined> {
  if (!phone) return undefined;
  const contact = await ctx.db
    .query("contacts")
    .withIndex("by_organization_and_phone", (q) =>
      q.eq("organizationId", organizationId).eq("phone", phone)
    )
    .first();
  return contact?._id;
}

/**
 * Registra o que a mensagem revelou sobre quem a enviou: nome (PushName) e
 * vínculo com um contato existente. Devolve o `contactId` resolvido para a
 * mensagem carimbar `senderContactId`.
 *
 * SÓ em grupo ACOMPANHADO (review de segurança nº 1). Numa sala não monitorada
 * — o grupo de família ou da escola no número pessoal do cliente — cada
 * mensagem enriquecia nome e telefone de terceiros que ninguém pediu para
 * guardar. O que continua acontecendo lá é o bump de `lastMessageAt`, que é o
 * que a lista precisa para dizer "ativo há 5 min" antes de alguém decidir.
 */
export async function recordParticipantFromMessage(
  ctx: MutationCtx,
  group: Doc<"groupChats">,
  sender: { lid?: string; phone?: string; name?: string },
  now: number
): Promise<Id<"contacts"> | undefined> {
  const lastMessageAt = Math.max(group.lastMessageAt ?? 0, now);

  if (group.monitored !== true) {
    // Nem a busca do contato acontece: sem gravar o participante, o
    // `senderContactId` não tem para onde ir (a mensagem nem é persistida).
    if (lastMessageAt !== group.lastMessageAt) {
      await ctx.db.patch(group._id, { lastMessageAt, updatedAt: now });
    }
    return undefined;
  }

  const contactId = await findContactIdByPhone(ctx, group.organizationId, sender.phone);
  if (!sender.lid && !sender.phone) {
    // Evento sem chave nenhuma: nada a mesclar, mas a sala continua ativa.
    if (lastMessageAt !== group.lastMessageAt) {
      await ctx.db.patch(group._id, { lastMessageAt, updatedAt: now });
    }
    return contactId;
  }
  const participants = mergeParticipant(group.participants, {
    ...(sender.lid ? { lid: sender.lid } : {}),
    ...(sender.phone ? { phone: sender.phone } : {}),
    ...(sender.name ? { name: sender.name } : {}),
    ...(contactId ? { contactId } : {}),
  });
  await ctx.db.patch(group._id, {
    participants,
    participantsCount: participants.filter((p) => p.leftAt === undefined).length,
    lastMessageAt,
    updatedAt: now,
  });
  return contactId;
}

/**
 * O JID (ou telefone) mencionado aponta para NÓS?
 *
 * `MentionedJID` chega ora em LID, ora em telefone — comparar com os dois é o
 * que evita perder a menção justamente quando ela importa.
 */
export function mentionsUs(
  mentions: string[] | undefined,
  ourLid: string | undefined,
  ourPhone: string | undefined
): boolean {
  if (!mentions || mentions.length === 0) return false;
  return mentions.some((raw) => {
    if (ourLid && raw === ourLid) return true;
    const user = raw.split("@")[0].split(":")[0].split(".")[0];
    if (ourLid && user === ourLid.split("@")[0]) return true;
    if (ourPhone && user.replace(/\D/g, "") === ourPhone) return true;
    return false;
  });
}

/**
 * Campos de `groupChats` derivados de um documento do gateway. Fora daqui só
 * ficam `monitored`/`conversationId`/`ai` — o que é decisão do operador, não do
 * WhatsApp, e que uma sincronização jamais pode sobrescrever.
 */
export function groupFieldsFromGateway(
  group: ParsedGroupInfo,
  ourLid: string | undefined,
  ourPhone: string | undefined,
  now: number
): Partial<Doc<"groupChats">> {
  const me = findSelfParticipant(group.participants, ourLid, ourPhone);
  return {
    subject: group.subject.slice(0, GROUP_SUBJECT_CAP),
    ...(group.topic !== undefined ? { topic: group.topic.slice(0, GROUP_TOPIC_CAP) } : {}),
    ...(group.ownerJid !== undefined ? { ownerJid: group.ownerJid } : {}),
    ...(group.createdAtWa !== undefined ? { createdAtWa: group.createdAtWa } : {}),
    isAnnounce: group.isAnnounce,
    isLocked: group.isLocked,
    isEphemeral: group.isEphemeral,
    ...(group.disappearingTimer !== undefined
      ? { disappearingTimer: group.disappearingTimer }
      : {}),
    isCommunityParent: group.isCommunityParent,
    ...(group.linkedParentJid !== undefined ? { linkedParentJid: group.linkedParentJid } : {}),
    ...(group.addressingMode ? { addressingMode: group.addressingMode } : {}),
    weAreAdmin: me?.isAdmin === true || me?.isSuperAdmin === true,
    weAreSuperAdmin: me?.isSuperAdmin === true,
    lastSyncAt: now,
    removedAt: undefined,
    updatedAt: now,
  };
}

/**
 * Membros HUMANOS ativos da org com um nível mínimo de permissão. Usado para
 * notificar sobre grupo (entrada nova, menção ao nosso número) sem destinatário
 * definido. Cap de 25, igual ao broadcast de repasse — protege a transação em
 * org grande.
 */
export async function membersWithPermission(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">,
  category: PermissionCategory,
  level: string
): Promise<Doc<"teamMembers">[]> {
  const members = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) =>
      q.eq("organizationId", organizationId).eq("type", "human")
    )
    .collect();
  return members
    .filter(
      (m) =>
        m.status === "active" &&
        hasPermission(resolvePermissions(m.role as Role, m.permissions ?? undefined), category, level)
    )
    .slice(0, 25);
}
