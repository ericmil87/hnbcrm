/**
 * Tipo de contato ("Não é cliente / Virar lead", PR1). PURO e importável pelo
 * front (`src/`): tipos, rótulos PT-BR, validadores e as regras que dizem o que
 * um contato fora do comercial bloqueia.
 *
 * - `contacts.relation` AUSENTE = não classificado: comporta-se exatamente como
 *   antes (a IA atende, funil, campanhas). `"customer"` = cliente confirmado.
 * - Os outros cinco valores são "fora do comercial" (`isOffBusiness`): a IA
 *   nunca responde nem processa (LLM, transcrição, visão, PDF, tradução), sem
 *   follow-up, campanha, repasse, cota de atendimento IA, e os leads abertos
 *   saem do funil (arquivados, nunca apagados — a conversa 1:1 precisa do lead).
 * - `conversations.contactRelation` é ESPELHO do contato (selo/filtro na lista
 *   e portões baratos que só têm a conversa em mãos). Quem escreve: a porta
 *   única `setContactRelationCore` (`lib/contactRelationOps.ts`), a criação de
 *   conversa (`getOrCreateConversation`, `lib/groupMemberLead.ts`) e a troca de
 *   contato de um lead (`leads.ts`), via `lib/contactRelationGuard.ts`.
 *
 * Escritas ficam em `lib/contactRelationOps.ts` (separado para não criar ciclo
 * com `handoffs.ts`/`attendant.ts`); leituras com `ctx` em
 * `lib/contactRelationGuard.ts`.
 */
import { v } from "convex/values";

export const CONTACT_RELATIONS = ["customer", "personal", "team", "supplier", "partner", "automated"] as const;
export type ContactRelation = (typeof CONTACT_RELATIONS)[number];

export const CONTACT_RELATION_LABEL: Record<ContactRelation, string> = {
  customer: "Lead",
  personal: "Pessoal",
  team: "Equipe",
  supplier: "Fornecedor",
  partner: "Parceiro",
  automated: "Robô",
};

/** Quem gravou o tipo (`contacts.relationMeta.source`). */
export const CONTACT_RELATION_SOURCES = [
  "manual",
  "import",
  "suggestion",
  "telegram",
  "api",
  "team_phone",
  "ops",
] as const;
export type ContactRelationSource = (typeof CONTACT_RELATION_SOURCES)[number];

export const contactRelationValidator = v.union(
  v.literal("customer"),
  v.literal("personal"),
  v.literal("team"),
  v.literal("supplier"),
  v.literal("partner"),
  v.literal("automated"),
);

export const contactRelationSourceValidator = v.union(
  v.literal("manual"),
  v.literal("import"),
  v.literal("suggestion"),
  v.literal("telegram"),
  v.literal("api"),
  v.literal("team_phone"),
  v.literal("ops"),
);

export const contactRelationMetaValidator = v.object({
  setAt: v.number(),
  setBy: v.optional(v.id("teamMembers")),
  source: contactRelationSourceValidator,
});

/** Motivo de elegibilidade/estado da IA (paridade em `lib/aiStateReasons.ts`). */
export const CONTACT_RELATION_AI_REASON = "contato_nao_cliente" as const;

export function isContactRelation(value: unknown): value is ContactRelation {
  return typeof value === "string" && (CONTACT_RELATIONS as readonly string[]).includes(value);
}

/** Fora do comercial: Pessoal, Equipe, Fornecedor, Parceiro, Robô. Ausente/`customer` = não. */
export function isOffBusiness(relation?: ContactRelation | null): boolean {
  return relation !== undefined && relation !== null && relation !== "customer";
}

/** Motivo que barra a IA para este tipo, ou null (mesma regra nos dois pontos do atendente). */
export function aiBlockReason(relation?: ContactRelation | null): typeof CONTACT_RELATION_AI_REASON | null {
  return isOffBusiness(relation) ? CONTACT_RELATION_AI_REASON : null;
}

/**
 * Tipo efetivo para uma conversa: o CONTATO manda quando foi lido; sem contato
 * em mãos, vale o espelho da conversa.
 */
export function effectiveRelation(
  contact: { relation?: ContactRelation } | null | undefined,
  conversation: { contactRelation?: ContactRelation } | null | undefined,
): ContactRelation | undefined {
  if (contact) return contact.relation;
  return conversation?.contactRelation;
}

/**
 * Lead criado AUTOMATICAMENTE (ingest, importação, campanha, cadastro do site)
 * para um contato fora do comercial nasce arquivado (âncora técnica da conversa,
 * fora do funil). Criação por humano não passa por aqui.
 */
export function autoLeadArchivePatch(
  relation: ContactRelation | null | undefined,
  now: number,
): { archivedAt?: number } {
  return isOffBusiness(relation) ? { archivedAt: now } : {};
}

/**
 * `restoreLead` padrão da porta única: SÓ ao sair de um tipo fora do comercial
 * para cliente ou sem tipo (traz o lead mais recente de volta ao funil, ou cria
 * um). Não classificado → "customer" não mexe em lead nenhum (um negócio
 * arquivado à mão continua arquivado).
 */
export function defaultRestoreLead(previous: ContactRelation | null, next: ContactRelation | null): boolean {
  return isOffBusiness(previous) && !isOffBusiness(next);
}

/** Erro reconhecível pelo front quando uma ação de IA esbarra num contato fora do comercial. */
export const NEEDS_RELATION_CODE = "needs_relation" as const;

export function needsRelationMessage(relation: ContactRelation): string {
  return `Este contato está marcado como ${CONTACT_RELATION_LABEL[relation]}. Vire lead antes de usar a IA nesta conversa.`;
}
