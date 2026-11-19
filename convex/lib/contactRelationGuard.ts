/**
 * Tipo de contato — leituras com `ctx` e o espelho na conversa (sem efeitos
 * colaterais além do patch do espelho). Importável por `handoffs.ts`,
 * `attendant.ts` e `conversations.ts` sem ciclo: depende só de `lib/` puro.
 *
 * - `assertAiAllowedForLead`: as ações de IA pedidas por um humano (Devolver à
 *   IA, recusar repasse, pedir rascunho) checam ANTES de qualquer escrita e
 *   lançam `ConvexError({code:"needs_relation", relation, message})`.
 * - `contactRelationMirrorFor`: campos do espelho para o INSERT de uma conversa.
 * - `syncContactRelationMirrorForLead`: recalcula o espelho das conversas de um
 *   lead (troca de contato do lead).
 */
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  NEEDS_RELATION_CODE,
  isOffBusiness,
  needsRelationMessage,
  type ContactRelation,
} from "./contactRelation";
import { OFF_BUSINESS_RELATIONS } from "./contactRelationFilter";
import { normalizeCampaignPhone, phoneLookupCandidates } from "./phone";

type Db = QueryCtx["db"] | MutationCtx["db"];

/** Teto de conversas por lead que o espelho percorre (lead tem 1 por canal). */
export const MIRROR_CONVERSATIONS_PER_LEAD = 20;

/** Tipo do contato de um lead (ausente = não classificado). */
export async function relationOfLead(
  db: Db,
  lead: Pick<Doc<"leads">, "contactId" | "organizationId"> | null | undefined,
): Promise<ContactRelation | undefined> {
  if (!lead?.contactId) return undefined;
  const contact = await db.get(lead.contactId);
  if (!contact || contact.organizationId !== lead.organizationId) return undefined;
  return contact.relation;
}

/** Erro reconhecível (o front lê `data.code === "needs_relation"`). */
export function needsRelationError(relation: ContactRelation): ConvexError<{
  code: typeof NEEDS_RELATION_CODE;
  relation: ContactRelation;
  message: string;
}> {
  return new ConvexError({ code: NEEDS_RELATION_CODE, relation, message: needsRelationMessage(relation) });
}

/**
 * Ação de IA pedida por um humano numa conversa de contato fora do comercial:
 * lança ANTES de qualquer escrita (nada fica pela metade). Sem lead = nada a checar.
 */
export async function assertAiAllowedForLead(
  db: Db,
  lead: Pick<Doc<"leads">, "contactId" | "organizationId"> | null | undefined,
): Promise<void> {
  const relation = await relationOfLead(db, lead);
  if (relation !== undefined && isOffBusiness(relation)) throw needsRelationError(relation);
}

/** Campos do espelho para o insert de uma conversa 1:1 do lead (vazio = sem tipo). */
export async function contactRelationMirrorFor(
  db: Db,
  leadId: Id<"leads"> | undefined,
): Promise<{ contactRelation?: ContactRelation }> {
  if (!leadId) return {};
  const lead = await db.get(leadId);
  const relation = await relationOfLead(db, lead);
  return relation !== undefined ? { contactRelation: relation } : {};
}

/** Regrava o espelho nas conversas do lead quando diverge. Devolve quantas mudaram. */
export async function syncContactRelationMirrorForLead(
  ctx: MutationCtx,
  leadId: Id<"leads">,
  relation: ContactRelation | undefined,
): Promise<number> {
  const conversations = await ctx.db
    .query("conversations")
    .withIndex("by_lead", (q) => q.eq("leadId", leadId))
    .take(MIRROR_CONVERSATIONS_PER_LEAD);
  let changed = 0;
  for (const conversation of conversations) {
    if (conversation.kind === "group" || conversation.contactRelation === relation) continue;
    await ctx.db.patch(conversation._id, { contactRelation: relation });
    changed += 1;
  }
  return changed;
}

/** Espelho recalculado a partir do contato ATUAL do lead (troca de contato). */
export async function resyncLeadContactRelationMirror(ctx: MutationCtx, leadId: Id<"leads">): Promise<number> {
  const lead = await ctx.db.get(leadId);
  if (!lead) return 0;
  return await syncContactRelationMirrorForLead(ctx, leadId, await relationOfLead(ctx.db, lead));
}

/**
 * Teto de contatos fora do comercial lidos por execução (campanhas, Central).
 * Uma org tem dezenas na prática; acima do teto o chamador sinaliza parcial e
 * a checagem por destinatário no envio (`campaignWorker.recipientIsNonCustomer`)
 * continua sendo a rede.
 */
export const NON_CUSTOMER_CONTACTS_CAP = 2000;

/**
 * Contatos fora do comercial da org, por range do índice
 * `by_organization_and_relation` (um por tipo; nunca varre a org).
 */
export async function loadNonCustomerContacts(
  db: Db,
  organizationId: Id<"organizations">,
  cap: number = NON_CUSTOMER_CONTACTS_CAP,
): Promise<{ contacts: Doc<"contacts">[]; truncated: boolean }> {
  const contacts: Doc<"contacts">[] = [];
  for (const relation of OFF_BUSINESS_RELATIONS) {
    const remaining = cap - contacts.length;
    if (remaining <= 0) return { contacts, truncated: true };
    const rows = await db
      .query("contacts")
      .withIndex("by_organization_and_relation", (q) =>
        q.eq("organizationId", organizationId).eq("relation", relation),
      )
      .take(remaining + 1);
    if (rows.length > remaining) return { contacts: [...contacts, ...rows.slice(0, remaining)], truncated: true };
    contacts.push(...rows);
  }
  return { contacts, truncated: false };
}

/**
 * Telefones normalizados (com a variante do 9º dígito) dos contatos dados —
 * `phone` e `whatsappNumber`. Casa com o telefone já normalizado de um
 * destinatário de campanha.
 */
export function phoneKeysOfContacts(contacts: Doc<"contacts">[], defaultCountry: string | undefined): Set<string> {
  const keys = new Set<string>();
  for (const contact of contacts) {
    for (const raw of [contact.phone, contact.whatsappNumber]) {
      if (!raw) continue;
      const normalized = normalizeCampaignPhone(raw, defaultCountry);
      if (!normalized.ok) continue;
      for (const candidate of phoneLookupCandidates(normalized.phone)) keys.add(candidate);
    }
  }
  return keys;
}
