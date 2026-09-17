/**
 * Segmentação server-side do público de uma campanha (leads existentes).
 *
 * Primeiro corte por índice (estágio > responsável > board > org), o resto em
 * JS. Cada lead vira no máximo 1 candidato (1 telefone). Devolve também a
 * contagem de exclusões por motivo, para a UI mostrar "12 sem telefone,
 * 3 na lista de supressão…".
 *
 * Limite de varredura: MAX_SCAN leads (v1 — orgs maiores segmentam por board).
 */
import { QueryCtx, MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { normalizeCampaignPhone } from "./phone";

export const MAX_SCAN = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AudienceFilters {
  boardId?: Id<"boards">;
  stageIds?: Id<"stages">[];
  tags?: string[];
  assignedTo?: Id<"teamMembers">;
  temperature?: "cold" | "warm" | "hot";
  priority?: "low" | "medium" | "high" | "urgent";
  lastActivityBefore?: number;
  lastActivityAfter?: number;
  onlyOpenWindow?: boolean;
  excludeCampaignedWithinDays?: number;
  excludeRepliedToCampaigns?: boolean;
}

export interface AudienceCandidate {
  leadId: Id<"leads">;
  contactId: Id<"contacts">;
  phone: string;
  displayName?: string;
  vars: Record<string, string>;
}

export type ExclusionReason =
  | "no_contact"
  | "no_phone"
  | "invalid_phone"
  | "duplicate_phone"
  | "opted_out"
  | "window_closed"
  | "campaigned_recently"
  | "replied_before";

export interface AudienceResult {
  candidates: AudienceCandidate[];
  excluded: Record<ExclusionReason, number>;
  scanned: number;
  truncated: boolean;
}

export function contactDisplayName(contact: Doc<"contacts">): string | undefined {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
  return name || undefined;
}

export function contactVars(contact: Doc<"contacts">, lead?: Doc<"leads"> | null): Record<string, string> {
  const vars: Record<string, string> = {};
  const set = (k: string, v: unknown) => {
    if (typeof v === "string" && v.trim()) vars[k] = v.trim();
  };
  set("nome", contactDisplayName(contact));
  set("primeiro_nome", contact.firstName);
  set("sobrenome", contact.lastName);
  set("email", contact.email);
  set("empresa", contact.company);
  set("cargo", contact.title);
  set("cidade", contact.city);
  set("estado", contact.state);
  if (lead) {
    set("lead", lead.title);
    for (const [k, v] of Object.entries(lead.customFields ?? {})) {
      if (typeof v === "string" || typeof v === "number") vars[k] = String(v);
    }
  }
  return vars;
}

export async function isPhoneSuppressed(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  phone: string
): Promise<boolean> {
  const row = await ctx.db
    .query("optOuts")
    .withIndex("by_organization_and_phone", (q) =>
      q.eq("organizationId", organizationId).eq("phone", phone)
    )
    .first();
  return row !== null;
}

/** Já recebeu campanha nos últimos N dias / já respondeu a alguma campanha? */
async function campaignHistory(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  phone: string
): Promise<Doc<"campaignRecipients">[]> {
  return await ctx.db
    .query("campaignRecipients")
    .withIndex("by_organization_and_phone", (q) =>
      q.eq("organizationId", organizationId).eq("phone", phone)
    )
    .take(50);
}

export async function resolveSegmentAudience(
  ctx: QueryCtx | MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    filters: AudienceFilters;
    now: number;
    limit?: number; // teto de candidatos devolvidos (preview usa pequeno)
    scanOffset?: number; // snapshot em lotes: pula os N primeiros leads do corte
    scanLimit?: number; // e varre no máximo M (default MAX_SCAN)
  }
): Promise<AudienceResult> {
  const { organizationId, filters, now } = args;
  const excluded: Record<ExclusionReason, number> = {
    no_contact: 0,
    no_phone: 0,
    invalid_phone: 0,
    duplicate_phone: 0,
    opted_out: 0,
    window_closed: 0,
    campaigned_recently: 0,
    replied_before: 0,
  };

  const scanOffset = Math.max(0, args.scanOffset ?? 0);
  const scanLimit = Math.max(1, Math.min(MAX_SCAN, args.scanLimit ?? MAX_SCAN));
  const takeN = scanOffset + scanLimit + 1;

  // Primeiro corte por índice
  let leads: Doc<"leads">[];
  if (filters.stageIds && filters.stageIds.length === 1) {
    const stageId = filters.stageIds[0];
    leads = await ctx.db
      .query("leads")
      .withIndex("by_organization_and_stage", (q) =>
        q.eq("organizationId", organizationId).eq("stageId", stageId)
      )
      .take(takeN);
  } else if (filters.assignedTo) {
    const assignedTo = filters.assignedTo;
    leads = await ctx.db
      .query("leads")
      .withIndex("by_organization_and_assigned", (q) =>
        q.eq("organizationId", organizationId).eq("assignedTo", assignedTo)
      )
      .take(takeN);
  } else if (filters.boardId) {
    const boardId = filters.boardId;
    leads = await ctx.db
      .query("leads")
      .withIndex("by_organization_and_board", (q) =>
        q.eq("organizationId", organizationId).eq("boardId", boardId)
      )
      .take(takeN);
  } else {
    leads = await ctx.db
      .query("leads")
      .withIndex("by_organization_and_archived", (q) =>
        q.eq("organizationId", organizationId).eq("archivedAt", undefined)
      )
      .take(takeN);
  }
  const truncated = leads.length > scanOffset + scanLimit;
  leads = leads.slice(scanOffset, scanOffset + scanLimit);
  const scannedCount = leads.length;

  // Filtros em JS
  const stageSet = filters.stageIds && filters.stageIds.length > 0 ? new Set(filters.stageIds) : null;
  const tagList = (filters.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  leads = leads.filter((lead) => {
    if (lead.archivedAt !== undefined) return false;
    if (filters.boardId && lead.boardId !== filters.boardId) return false;
    if (stageSet && !stageSet.has(lead.stageId)) return false;
    if (filters.assignedTo && lead.assignedTo !== filters.assignedTo) return false;
    if (filters.temperature && lead.temperature !== filters.temperature) return false;
    if (filters.priority && lead.priority !== filters.priority) return false;
    if (filters.lastActivityBefore !== undefined && (lead.lastActivityAt ?? lead.updatedAt) >= filters.lastActivityBefore) return false;
    if (filters.lastActivityAfter !== undefined && (lead.lastActivityAt ?? lead.updatedAt) < filters.lastActivityAfter) return false;
    if (tagList.length > 0) {
      const leadTags = new Set(lead.tags.map((t) => t.toLowerCase()));
      if (!tagList.every((t) => leadTags.has(t))) return false;
    }
    return true;
  });

  const seen = new Set<string>();
  const candidates: AudienceCandidate[] = [];
  const limit = args.limit ?? Number.MAX_SAFE_INTEGER;

  for (const lead of leads) {
    if (!lead.contactId) {
      excluded.no_contact++;
      continue;
    }
    const contact = await ctx.db.get(lead.contactId);
    if (!contact) {
      excluded.no_contact++;
      continue;
    }
    const raw = contact.whatsappNumber ?? contact.phone;
    if (!raw) {
      excluded.no_phone++;
      continue;
    }
    const normalized = normalizeCampaignPhone(raw);
    if (!normalized.ok) {
      excluded.invalid_phone++;
      continue;
    }
    const phone = normalized.phone;
    if (seen.has(phone)) {
      excluded.duplicate_phone++;
      continue;
    }
    if (await isPhoneSuppressed(ctx, organizationId, phone)) {
      seen.add(phone);
      excluded.opted_out++;
      continue;
    }
    if (filters.onlyOpenWindow) {
      const convo = await ctx.db
        .query("conversations")
        .withIndex("by_lead_and_channel", (q) => q.eq("leadId", lead._id).eq("channel", "whatsapp"))
        .first();
      const open = convo?.lastInboundAt !== undefined && convo.lastInboundAt + DAY_MS > now;
      if (!open) {
        seen.add(phone);
        excluded.window_closed++;
        continue;
      }
    }
    if (filters.excludeCampaignedWithinDays || filters.excludeRepliedToCampaigns) {
      const history = await campaignHistory(ctx, organizationId, phone);
      if (filters.excludeRepliedToCampaigns && history.some((r) => r.status === "replied")) {
        seen.add(phone);
        excluded.replied_before++;
        continue;
      }
      if (filters.excludeCampaignedWithinDays) {
        const since = now - filters.excludeCampaignedWithinDays * DAY_MS;
        const recent = history.some(
          (r) => (r.sentAt ?? r.createdAt) >= since && r.status !== "pending" && r.status !== "skipped"
        );
        if (recent) {
          seen.add(phone);
          excluded.campaigned_recently++;
          continue;
        }
      }
    }
    seen.add(phone);
    candidates.push({
      leadId: lead._id,
      contactId: contact._id,
      phone,
      displayName: contactDisplayName(contact),
      vars: contactVars(contact, lead),
    });
    if (candidates.length >= limit) break;
  }

  return { candidates, excluded, scanned: scannedCount, truncated };
}

// ─────────────────────────────────────────────────────────────────────────────
// Públicos de GRUPO (v0.57 / F5 — §7 e §7.1 do plano, D9 e D15)
//
// Tudo aqui é PURO: recebe os documentos já carregados e devolve os candidatos
// mais o funil de contagem que a prévia do wizard mostra. Quem lê o banco é
// `campaigns.ts` (prévia e snapshot usam exatamente os mesmos builders, para a
// prévia não prometer um número que o lançamento não entrega).
// ─────────────────────────────────────────────────────────────────────────────

export interface GroupParticipantLike {
  lid?: string;
  phone?: string;
  name?: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  contactId?: Id<"contacts">;
  leftAt?: number;
}

export interface GroupAudienceGroup {
  groupChatId: Id<"groupChats">;
  subject: string;
  jid: string;
  monitored: boolean;
  conversationId?: Id<"conversations">;
  /** Chave do NOSSO número dentro de participants (lid ?? phone) — nunca entra. */
  selfKey?: string | null;
  /** Nosso telefone, quando conhecido: o self também é filtrado por telefone. */
  selfPhone?: string | null;
  participants: GroupParticipantLike[];
  participantsCount?: number;
}

export interface MemberAudienceFilters {
  excludeAdmins?: boolean;
  excludeExistingContacts?: boolean;
  excludeCampaignedWithinDays?: number;
  activeInGroupWithinDays?: number;
  excludeGroupChatIds?: Id<"groupChats">[];
  /** Seleção explícita: chaves (`lid ?? phone`) de quem foi marcado na tela. */
  includeKeys?: string[];
}

/** Teto de chaves em `includeKeys` — o mesmo teto de membros de um grupo. */
export const INCLUDE_KEYS_MAX = 1024;

export type MemberExclusionReason =
  | "self"
  | "left"
  | "no_phone"
  | "invalid_phone"
  | "duplicate"
  | "opted_out"
  | "admin"
  | "existing_contact"
  | "campaigned_recently"
  | "inactive_in_group"
  | "in_excluded_group"
  | "not_selected";

export interface GroupMemberCandidate {
  phone: string;
  memberName?: string;
  sourceGroupChatId: Id<"groupChats">;
  sourceGroupSubject: string;
  lid?: string;
  contactId?: Id<"contacts">;
  isAdmin: boolean;
}

/**
 * Funil que a prévia mostra, na ordem do §7.1:
 * total → com telefone → sem duplicata entre grupos → sem opt-out → finais.
 */
export interface MemberAudienceFunnel {
  total: number;
  withPhone: number;
  deduped: number;
  afterOptOut: number;
  afterFilters: number;
  final: number;
}

/**
 * Uma linha da lista "quem vai receber" da prévia.
 *
 * A lista mostra TODO MUNDO que ainda está na sala — inclusive quem ficou de
 * fora — e diz o porquê em `excludedReason`. É o que transforma o funil de
 * números ("25 → 18 → 12") em algo acionável: o operador vê que o Bruno sumiu
 * porque é admin, não porque o CRM perdeu o telefone dele.
 *
 * `phone` só vem preenchido para quem tem `inbox:view_all`; para todos os
 * outros existe apenas `phoneMasked` (D3/LGPD: são terceiros que nunca falaram
 * com a empresa). Quem decide é o CHAMADOR, via `memberList.revealPhones` —
 * assim não há caminho em que o número cru escape por esquecimento de filtrar.
 */
export interface GroupMemberRow {
  /** Chave do participante (`lid ?? phone`) — é ela que vai em `includeKeys`. */
  key: string;
  name?: string;
  phoneMasked: string;
  phone?: string;
  isAdmin: boolean;
  groupChatId: Id<"groupChats">;
  groupSubject: string;
  /** O telefone já é um contato da org (D3: membro não vira contato sozinho). */
  isContact: boolean;
  /** Ausente = entra no disparo. */
  excludedReason?: MemberExclusionReason;
}

export interface GroupMemberAudienceResult {
  recipients: GroupMemberCandidate[];
  funnel: MemberAudienceFunnel;
  excluded: Record<MemberExclusionReason, number>;
  sample: Array<{ name: string | null; phone: string; group: string }>;
  perGroup: Array<{ groupChatId: Id<"groupChats">; subject: string; count: number }>;
  /** Bateu no `limit`: há mais gente elegível do que a campanha vai levar. */
  truncated: boolean;
  /** Quantos ficaram de fora SÓ pelo teto (não por filtro). */
  overLimit: number;
  /** Lista "quem vai receber" — vazia quando o chamador não pediu. */
  members: GroupMemberRow[];
  /** A lista bateu no teto de linhas: não dá para escolher pessoa a pessoa. */
  membersTruncated: boolean;
  /** Quantas linhas a lista TERIA sem o teto. */
  membersTotal: number;
}

export const MEMBER_SAMPLE_SIZE = 10;
/** Teto de linhas da lista de membros da prévia (é uma query reativa). */
export const MEMBER_LIST_MAX = 500;

function emptyMemberExclusions(): Record<MemberExclusionReason, number> {
  return {
    self: 0,
    left: 0,
    no_phone: 0,
    invalid_phone: 0,
    duplicate: 0,
    opted_out: 0,
    admin: 0,
    existing_contact: 0,
    campaigned_recently: 0,
    inactive_in_group: 0,
    in_excluded_group: 0,
    not_selected: 0,
  };
}

/** Chave do participante dentro de `participants[]` — a mesma do ingest. */
export function participantKey(p: GroupParticipantLike): string {
  return p.lid ?? p.phone ?? "";
}

/**
 * Salas cujo NOSSO número é desconhecido (o canal não tem `bridgeLid` nem
 * `bridgePhone`).
 *
 * Sem a identidade própria o filtro `self` do builder NUNCA casa, e o número da
 * própria empresa entra no público como se fosse um cliente qualquer: a
 * campanha manda a mensagem de prospecção para ela mesma e, pior, o
 * destinatário conta no teto por grupo/dia no lugar de uma pessoa real. Em
 * gateway GERENCIADO o número sai do `/admin/users`; em self-hosted ele só é
 * aprendido quando uma mensagem NOSSA passa por um grupo (v0.57, correção 22),
 * então a lacuna é real e silenciosa.
 *
 * O público "grupos" (postar na sala) não precisa disto: lá o destinatário é o
 * JID da sala, não uma pessoa.
 */
export function groupsWithUnknownSelf(groups: GroupAudienceGroup[]): GroupAudienceGroup[] {
  return groups.filter((g) => !g.selfKey && !g.selfPhone);
}

/** Mensagem única (tela, REST e copiloto dizem a mesma coisa). */
export function unknownSelfMessage(groups: GroupAudienceGroup[]): string {
  const names = groups.map((g) => `«${g.subject}»`);
  const head =
    names.length === 1
      ? `O CRM ainda não sabe qual é o nosso número no grupo ${names[0]}`
      : `O CRM ainda não sabe qual é o nosso número em ${names.length} grupos (${names
          .slice(0, 3)
          .join(", ")}${names.length > 3 ? "…" : ""})`;
  return (
    `${head}. Sem isso o próprio número da empresa entraria na lista de destinatários. ` +
    `Envie uma mensagem por esse número em um dos grupos (pelo CRM ou pelo celular) e ` +
    `tente de novo — é assim que a identidade é aprendida em gateway próprio.`
  );
}

/**
 * Público "membros de grupos" (D15).
 *
 * A ORDEM dos grupos importa: o primeiro em que a pessoa aparece vence como
 * `sourceGroupChatId`, então o relatório por grupo de origem não conta a mesma
 * pessoa duas vezes e ela recebe UMA mensagem só.
 *
 * `activeKeys` mapeia grupo → chaves (lid E telefone) de quem falou na janela
 * de `activeInGroupWithinDays`. O plano fala em LID; casar também pelo telefone
 * é de graça e cobre o grupo em modo `pn`, onde a mensagem não traz LID nenhum.
 *
 * `filters.includeKeys` é a SELEÇÃO da tela e entra por último, depois de todos
 * os outros filtros: quem foi marcado mas é admin (com "excluir admins" ligado)
 * sai como `admin`, não como `not_selected`. Assim `not_selected` significa
 * exatamente uma coisa — "passaria, mas ninguém marcou" — e é isso que a UI usa
 * para saber quem são os elegíveis.
 *
 * `memberList` liga a lista "quem vai receber". Ela é montada na MESMA varredura
 * do funil de propósito: prévia e lista não podem discordar sobre quem entra.
 */
export function buildGroupMembersAudience(args: {
  groups: GroupAudienceGroup[];
  filters?: MemberAudienceFilters;
  /** Telefones (normalizados) que JÁ são contato na org. */
  existingContactPhones?: Set<string>;
  /** Telefones que receberam campanha dentro de `excludeCampaignedWithinDays`. */
  recentlyCampaigned?: Set<string>;
  /** Lista de supressão org-wide. */
  optOuts?: Set<string>;
  /** groupChatId → chaves ativas na janela. */
  activeKeys?: Map<string, Set<string>>;
  /** Telefones (normalizados) dos grupos em `excludeGroupChatIds`. */
  excludedGroupPhones?: Set<string>;
  limit?: number;
  /** Ausente = sem lista de membros (snapshot não precisa). */
  memberList?: { limit?: number; revealPhones?: boolean };
}): GroupMemberAudienceResult {
  const filters = args.filters ?? {};
  const excluded = emptyMemberExclusions();
  const recipients: GroupMemberCandidate[] = [];
  const perGroup: Array<{ groupChatId: Id<"groupChats">; subject: string; count: number }> = [];
  const seen = new Set<string>();
  const limit = args.limit ?? Number.MAX_SAFE_INTEGER;
  const includeKeys =
    filters.includeKeys && filters.includeKeys.length > 0 ? new Set(filters.includeKeys) : null;

  const wantRows = args.memberList !== undefined;
  const rowLimit = Math.max(0, args.memberList?.limit ?? MEMBER_LIST_MAX);
  const revealPhones = args.memberList?.revealPhones === true;
  const members: GroupMemberRow[] = [];
  let membersTotal = 0;
  let membersTruncated = false;

  const pushRow = (
    group: GroupAudienceGroup,
    p: GroupParticipantLike,
    key: string,
    phone: string | undefined,
    isContact: boolean,
    reason?: MemberExclusionReason
  ) => {
    if (!wantRows) return;
    membersTotal++;
    if (members.length >= rowLimit) {
      membersTruncated = true;
      return;
    }
    const name = p.name?.trim();
    members.push({
      key,
      ...(name ? { name } : {}),
      phoneMasked: phone ? maskMemberPhone(phone) : "",
      ...(revealPhones && phone ? { phone } : {}),
      isAdmin: p.isAdmin || p.isSuperAdmin,
      groupChatId: group.groupChatId,
      groupSubject: group.subject,
      isContact,
      ...(reason ? { excludedReason: reason } : {}),
    });
  };

  let total = 0;
  let withPhone = 0;
  let deduped = 0;
  let afterOptOut = 0;
  let overLimit = 0;

  for (const group of args.groups) {
    const active = args.activeKeys?.get(String(group.groupChatId));
    let count = 0;
    for (const p of group.participants ?? []) {
      // Quem saiu da sala não aparece nem na lista: não é decisão do operador.
      if (p.leftAt !== undefined) {
        excluded.left++;
        continue;
      }
      const key = participantKey(p);
      const knownContact = p.contactId !== undefined;
      const isSelf =
        (group.selfKey !== undefined && group.selfKey !== null && key === group.selfKey) ||
        (!!group.selfPhone && !!p.phone && p.phone === group.selfPhone);
      if (isSelf) {
        excluded.self++;
        pushRow(group, p, key, p.phone, knownContact, "self");
        continue;
      }
      total++;
      if (!p.phone) {
        excluded.no_phone++;
        pushRow(group, p, key, undefined, knownContact, "no_phone");
        continue;
      }
      const normalized = normalizeCampaignPhone(p.phone);
      if (!normalized.ok) {
        excluded.invalid_phone++;
        pushRow(group, p, key, p.phone, knownContact, "invalid_phone");
        continue;
      }
      const phone = normalized.phone;
      const isContact = knownContact || args.existingContactPhones?.has(phone) === true;
      withPhone++;
      if (seen.has(phone)) {
        excluded.duplicate++;
        pushRow(group, p, key, phone, isContact, "duplicate");
        continue;
      }
      seen.add(phone);
      deduped++;
      if (args.optOuts?.has(phone)) {
        excluded.opted_out++;
        pushRow(group, p, key, phone, isContact, "opted_out");
        continue;
      }
      afterOptOut++;
      if (filters.excludeAdmins && (p.isAdmin || p.isSuperAdmin)) {
        excluded.admin++;
        pushRow(group, p, key, phone, isContact, "admin");
        continue;
      }
      if (filters.excludeExistingContacts && isContact) {
        excluded.existing_contact++;
        pushRow(group, p, key, phone, isContact, "existing_contact");
        continue;
      }
      if (filters.excludeCampaignedWithinDays && args.recentlyCampaigned?.has(phone)) {
        excluded.campaigned_recently++;
        pushRow(group, p, key, phone, isContact, "campaigned_recently");
        continue;
      }
      if (filters.activeInGroupWithinDays) {
        const activeHere =
          active !== undefined && (active.has(key) || (p.lid !== undefined && active.has(p.lid)) || active.has(p.phone));
        if (!activeHere) {
          excluded.inactive_in_group++;
          pushRow(group, p, key, phone, isContact, "inactive_in_group");
          continue;
        }
      }
      if (args.excludedGroupPhones?.has(phone)) {
        excluded.in_excluded_group++;
        pushRow(group, p, key, phone, isContact, "in_excluded_group");
        continue;
      }
      // Seleção da tela: por último, para o motivo mostrado ser o REAL.
      if (includeKeys && !includeKeys.has(key)) {
        excluded.not_selected++;
        pushRow(group, p, key, phone, isContact, "not_selected");
        continue;
      }
      if (recipients.length >= limit) {
        overLimit++;
        pushRow(group, p, key, phone, isContact);
        continue;
      }
      recipients.push({
        phone,
        memberName: p.name?.trim() || undefined,
        sourceGroupChatId: group.groupChatId,
        sourceGroupSubject: group.subject,
        lid: p.lid,
        contactId: p.contactId,
        isAdmin: p.isAdmin || p.isSuperAdmin,
      });
      pushRow(group, p, key, phone, isContact);
      count++;
    }
    perGroup.push({ groupChatId: group.groupChatId, subject: group.subject, count });
  }

  return {
    recipients,
    members,
    membersTruncated,
    membersTotal,
    funnel: {
      total,
      withPhone,
      deduped,
      afterOptOut,
      // `afterFilters` é quem passou pelos filtros; `final` é quem a campanha
      // leva de fato. Só divergem quando o teto corta.
      afterFilters: recipients.length + overLimit,
      final: recipients.length,
    },
    truncated: overLimit > 0,
    overLimit,
    excluded,
    sample: recipients.slice(0, MEMBER_SAMPLE_SIZE).map((r) => ({
      name: r.memberName ?? null,
      phone: maskMemberPhone(r.phone),
      group: r.sourceGroupSubject,
    })),
    perGroup,
  };
}

/**
 * Chaves da seleção explícita, sem repetição e dentro do teto.
 *
 * Lança quando passa de `INCLUDE_KEYS_MAX` — a seleção vem de uma tela com
 * checkbox, então uma lista maior que a maior sala possível do WhatsApp é
 * chamada mal-formada, não "usuário escolheu muita gente".
 */
export function normalizeIncludeKeys(keys: string[] | undefined): string[] | undefined {
  if (!keys || keys.length === 0) return undefined;
  if (keys.length > INCLUDE_KEYS_MAX) {
    throw new Error(
      `A seleção de membros tem ${keys.length} pessoas — o máximo é ${INCLUDE_KEYS_MAX} (o tamanho máximo de um grupo)`
    );
  }
  const out = [...new Set(keys.map((k) => String(k).trim()).filter(Boolean))];
  return out.length > 0 ? out : undefined;
}

/** Telefone mascarado para a amostra da prévia (LGPD: são terceiros). */
export function maskMemberPhone(phone: string): string {
  const d = String(phone ?? "").replace(/\D+/g, "");
  if (d.length <= 4) return d ? `••••${d}` : "";
  return `${d.slice(0, d.length >= 12 ? 4 : 2)}••••${d.slice(-4)}`;
}

export type GroupExclusionReason = "not_monitored" | "no_conversation" | "duplicate" | "other_channel";

export interface GroupRecipientCandidate {
  groupChatId: Id<"groupChats">;
  jid: string;
  subject: string;
  conversationId: Id<"conversations">;
  participantsCount: number;
}

export interface GroupsAudienceResult {
  recipients: GroupRecipientCandidate[];
  excluded: Record<GroupExclusionReason, number>;
  /** Soma de `participantsCount` — alcance ESTIMADO (§7). */
  reach: number;
  skipped: Array<{ subject: string; reason: GroupExclusionReason }>;
}

/**
 * Público "grupos" (D9): um destinatário por sala monitorada com conversa.
 *
 * Sala sem conversa é sala que ninguém marcou para acompanhar — `setMonitored`
 * é quem cria a conversa, e sem ela não há para onde mandar.
 */
export function buildGroupsAudience(args: {
  groups: GroupAudienceGroup[];
  channelConfigId?: Id<"channelConfigs">;
  channelOf?: (g: GroupAudienceGroup) => Id<"channelConfigs"> | undefined;
}): GroupsAudienceResult {
  const excluded: Record<GroupExclusionReason, number> = {
    not_monitored: 0,
    no_conversation: 0,
    duplicate: 0,
    other_channel: 0,
  };
  const recipients: GroupRecipientCandidate[] = [];
  const skipped: Array<{ subject: string; reason: GroupExclusionReason }> = [];
  const seen = new Set<string>();
  let reach = 0;

  for (const group of args.groups) {
    const add = (reason: GroupExclusionReason) => {
      excluded[reason]++;
      skipped.push({ subject: group.subject, reason });
    };
    if (args.channelConfigId && args.channelOf) {
      const channel = args.channelOf(group);
      if (channel !== undefined && channel !== args.channelConfigId) {
        add("other_channel");
        continue;
      }
    }
    if (!group.monitored) {
      add("not_monitored");
      continue;
    }
    if (!group.conversationId) {
      add("no_conversation");
      continue;
    }
    if (seen.has(group.jid)) {
      add("duplicate");
      continue;
    }
    seen.add(group.jid);
    const count =
      group.participants?.filter((p) => p.leftAt === undefined).length ?? group.participantsCount ?? 0;
    reach += count;
    recipients.push({
      groupChatId: group.groupChatId,
      jid: group.jid,
      subject: group.subject,
      conversationId: group.conversationId,
      participantsCount: count,
    });
  }
  return { recipients, excluded, reach, skipped };
}

/**
 * Quantos DIAS o público leva no modo seguro, dado o teto por grupo de origem.
 *
 * Aceita um número (um grupo só) ou a contagem por grupo — os grupos correm em
 * paralelo, então quem manda é o maior, não a soma.
 */
export function spreadOverDays(counts: number | number[], perGroupPerDay: number): number {
  const per = Math.max(1, Math.floor(perGroupPerDay));
  const list = typeof counts === "number" ? [counts] : counts;
  let days = 0;
  for (const c of list) days = Math.max(days, Math.ceil(Math.max(0, c) / per));
  return Math.max(list.length > 0 ? 1 : 0, days);
}

/**
 * Em que DIA (0 = hoje) cada destinatário entra, respeitando o teto por grupo.
 * É assim que o "espalhar em dias" acontece de verdade: vira `scheduledFor` no
 * snapshot, e o worker já pula o pendente agendado para o futuro.
 *
 * A ORDEM devolvida é intercalada por grupo (round-robin dentro de cada dia),
 * não grupo-a-grupo. O worker escolhe o próximo pendente numa janela finita da
 * fila: com a ordem group-major, as 190 linhas futuras do primeiro grupo
 * ocupavam a janela inteira e NINGUÉM do segundo grupo recebia no dia 0 — a
 * campanha prometia ~20 dias (o maior grupo) e levava 40 (a soma).
 */
export function assignSpreadDays<T extends { sourceGroupChatId: Id<"groupChats"> }>(
  recipients: T[],
  perGroupPerDay: number
): Array<T & { dayIndex: number }> {
  const per = Math.max(1, Math.floor(perGroupPerDay));
  const countByGroup = new Map<string, number>();
  // 1ª passada: dia de cada pessoa dentro do grupo dela.
  const withDay = recipients.map((r) => {
    const key = String(r.sourceGroupChatId);
    const n = countByGroup.get(key) ?? 0;
    countByGroup.set(key, n + 1);
    return { ...r, dayIndex: Math.floor(n / per) };
  });

  // 2ª passada: dia crescente e, dentro do dia, um de cada grupo por vez.
  const byDay = new Map<number, Map<string, Array<T & { dayIndex: number }>>>();
  const groupOrder: string[] = [];
  for (const r of withDay) {
    const key = String(r.sourceGroupChatId);
    if (!groupOrder.includes(key)) groupOrder.push(key);
    let day = byDay.get(r.dayIndex);
    if (!day) {
      day = new Map();
      byDay.set(r.dayIndex, day);
    }
    const bucket = day.get(key);
    if (bucket) bucket.push(r);
    else day.set(key, [r]);
  }

  const out: Array<T & { dayIndex: number }> = [];
  for (const dayIndex of [...byDay.keys()].sort((a, b) => a - b)) {
    const day = byDay.get(dayIndex)!;
    let remaining = true;
    let round = 0;
    while (remaining) {
      remaining = false;
      for (const key of groupOrder) {
        const bucket = day.get(key);
        if (bucket && round < bucket.length) {
          out.push(bucket[round]);
          if (round + 1 < bucket.length) remaining = true;
        }
      }
      round++;
    }
  }
  return out;
}
