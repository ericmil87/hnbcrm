/**
 * Filtro por tipo de contato (PR2 "Ver e filtrar"). PURO e importável pelo
 * front: o mesmo contrato vale para `conversations.getConversations({relation})`
 * e `contacts.getContacts({relation})`.
 *
 * Valores (chips do inbox/Contatos):
 * - `"leads"`    = cliente confirmado (`"customer"`) + sem tipo (campo ausente).
 * - `"personal"` = chip "Pessoais": QUALQUER tipo fora do comercial
 *   (Pessoal, Equipe, Fornecedor, Parceiro, Robô) — não só `relation:"personal"`.
 * - `"customer" | "team" | "supplier" | "partner" | "automated"` = só aquele tipo.
 * - `"none"`     = sem tipo (campo ausente).
 *
 * Cada filtro vira uma lista de valores do índice (`undefined` = ausente); o
 * servidor lê um range por valor e mescla (nunca `take(n)` + filtro em JS).
 */
import { v } from "convex/values";
import { CONTACT_RELATIONS, isOffBusiness, type ContactRelation } from "./contactRelation";

export const CONTACT_RELATION_FILTERS = [
  "leads",
  "personal",
  "customer",
  "team",
  "supplier",
  "partner",
  "automated",
  "none",
] as const;
export type ContactRelationFilter = (typeof CONTACT_RELATION_FILTERS)[number];

export const contactRelationFilterArgValidator = v.union(
  v.literal("leads"),
  v.literal("personal"),
  v.literal("customer"),
  v.literal("team"),
  v.literal("supplier"),
  v.literal("partner"),
  v.literal("automated"),
  v.literal("none"),
);

/** Os cinco tipos fora do comercial, na ordem de `CONTACT_RELATIONS`. */
export const OFF_BUSINESS_RELATIONS: readonly ContactRelation[] = CONTACT_RELATIONS.filter((r) => isOffBusiness(r));

/** Valores do índice que o filtro cobre (`undefined` = campo ausente = sem tipo). */
export function relationValuesForFilter(filter: ContactRelationFilter): Array<ContactRelation | undefined> {
  switch (filter) {
    case "leads":
      return [undefined, "customer"];
    case "none":
      return [undefined];
    case "personal":
      return [...OFF_BUSINESS_RELATIONS];
    default:
      return [filter];
  }
}

/** O filtro inclui "sem tipo"? (range grande: o resto da org cai nele). */
export function filterIncludesUnclassified(filter: ContactRelationFilter): boolean {
  return filter === "leads" || filter === "none";
}

/** Mesmo critério em memória (pós-filtro dos ramos que não usam o índice de tipo). */
export function matchesContactRelationFilter(
  relation: ContactRelation | undefined | null,
  filter: ContactRelationFilter,
): boolean {
  const value = relation ?? undefined;
  return relationValuesForFilter(filter).includes(value);
}
