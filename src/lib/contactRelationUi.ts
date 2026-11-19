import {
  CONTACT_RELATIONS,
  CONTACT_RELATION_LABEL,
  NEEDS_RELATION_CODE,
  isOffBusiness,
  type ContactRelation,
  type ContactRelationSource,
} from "../../convex/lib/contactRelation";
import { formatDate } from "./format";

// Lógica pura do "Não é cliente / Virar lead" (sem React): rótulo do botão da
// IA, modelo dos menus (botão da IA e ⋮), textos dos toasts, linha "Marcado
// por" e leitura do pedido de tipo (`needs_relation`) que o servidor devolve
// ao tentar acionar a IA num contato que não é cliente. Testada em
// `contactRelationUi.test.ts`.

export { CONTACT_RELATIONS, CONTACT_RELATION_LABEL, isOffBusiness, type ContactRelation };

/** Valor desconhecido (servidor mais novo, dado solto) vira `undefined`. */
export function asContactRelation(value: unknown): ContactRelation | undefined {
  return typeof value === "string" && (CONTACT_RELATIONS as readonly string[]).includes(value)
    ? (value as ContactRelation)
    : undefined;
}

/**
 * Tipo do contato da conversa: `contact.relation` quando veio no doc (o contato
 * manda, `effectiveRelation`), senão o espelho `contactRelation` da conversa.
 */
export function conversationContactRelation(
  conversation: { contactRelation?: unknown; contact?: { relation?: unknown } | null } | null | undefined
): ContactRelation | undefined {
  return asContactRelation(conversation?.contact?.relation) ?? asContactRelation(conversation?.contactRelation);
}

/** Tipo que tira o contato do atendimento (tudo menos Lead e sem tipo). */
export function offBusinessRelation(relation: ContactRelation | null | undefined): ContactRelation | null {
  return relation && isOffBusiness(relation) ? relation : null;
}

/** "Lead", "Pessoal"…; sem tipo = "Sem tipo". */
export function relationLabel(relation: ContactRelation | null | undefined): string {
  return relation ? CONTACT_RELATION_LABEL[relation] : "Sem tipo";
}

export type RelationTone = "default" | "brand" | "success" | "warning" | "info";

/** Cor do selo (variante do `Badge`, tokens do tema). */
export const RELATION_TONE: Record<ContactRelation, RelationTone> = {
  customer: "brand",
  personal: "info",
  team: "brand",
  supplier: "warning",
  partner: "success",
  automated: "default",
};

// ---------------------------------------------------------------------------
// Botão e menu da IA
// ---------------------------------------------------------------------------

export interface AiControlState {
  paused: boolean;
  /** `aiMode` "off" sem pausa. */
  off: boolean;
  /** IA esperando (chip "em espera"); só muda o rótulo do botão. */
  waiting?: boolean;
  relation?: ContactRelation | null;
}

/** Texto do botão da IA no cabeçalho (celular e computador). */
export function aiTriggerLabel(s: AiControlState): string {
  const off = offBusinessRelation(s.relation);
  if (off) return `IA desligada · ${CONTACT_RELATION_LABEL[off]}`;
  if (s.paused) return "IA pausada";
  if (s.off) return "IA desligada";
  if (s.waiting) return "IA em espera";
  return "IA ativa";
}

/** Linha de estado no topo do menu da IA. */
export function aiStateLine(s: AiControlState): string {
  const off = offBusinessRelation(s.relation);
  if (off) return `IA desligada · contato ${CONTACT_RELATION_LABEL[off]}`;
  if (s.paused) return "IA pausada nesta conversa";
  if (s.off) return "IA desligada nesta conversa";
  return "IA ativa nesta conversa";
}

/** IA silenciosa (cor apagada no botão). */
export function aiQuiet(s: AiControlState): boolean {
  return s.paused || s.off || !!offBusinessRelation(s.relation);
}

export type AiMenuItem = "assume" | "return" | "ask" | "turnLead" | "changeType" | "notCustomer";

export interface AiMenuInput extends AiControlState {
  hasPendingDraft: boolean;
  /** `inbox:reply`: assumir, devolver, pedir sugestão. */
  canReply: boolean;
  /** `contacts:edit`: trocar o tipo e "Virar lead". */
  canEditContact: boolean;
}

export interface AiMenuModel {
  /** Ações da IA (assumir, devolver, pedir) ou "Virar lead"/"Trocar tipo…" num marcado. */
  primary: AiMenuItem[];
  /** Depois do separador ("Não é cliente…"). */
  secondary: AiMenuItem[];
}

/**
 * Itens do menu da IA. Contato marcado (Pessoal, Equipe…): só "Virar lead" e
 * "Trocar tipo…" (a IA não atende, assumir ou pedir sugestão não faz sentido).
 * Os demais: as ações de hoje e, depois do separador, "Não é cliente…".
 */
export function aiMenuModel(input: AiMenuInput): AiMenuModel {
  if (offBusinessRelation(input.relation)) {
    return { primary: input.canEditContact ? ["turnLead", "changeType"] : [], secondary: [] };
  }
  const primary: AiMenuItem[] = [];
  if (input.canReply) {
    if (input.paused) primary.push("return");
    else {
      primary.push("assume");
      if (!input.hasPendingDraft) primary.push("ask");
    }
  }
  return { primary, secondary: input.canEditContact ? ["notCustomer"] : [] };
}

/**
 * Seção "Atendimento por IA" do menu ⋮: as mesmas ações do botão da IA (sem o
 * "Não é cliente…", que fica na seção "Contato"); num marcado, "Virar lead".
 */
export function actionsMenuAiItems(input: AiMenuInput & { showAiControls: boolean }): AiMenuItem[] {
  if (offBusinessRelation(input.relation)) return input.canEditContact ? ["turnLead"] : [];
  if (!input.showAiControls) return [];
  return aiMenuModel(input).primary;
}

// ---------------------------------------------------------------------------
// Toasts e textos
// ---------------------------------------------------------------------------

/** Primeiro nome para os toasts ("Mieko agora está como Pessoal"); sem nome, "Contato". */
export function shortName(name: string | null | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first || "Contato";
}

/** Toast depois de trocar o tipo. */
export function relationChangedText(name: string | null | undefined, relation: ContactRelation | null): string {
  const who = shortName(name);
  if (relation === "customer") return `${who} agora é lead`;
  if (relation === null) return `${who} agora está sem tipo`;
  return `${who} agora está como ${CONTACT_RELATION_LABEL[relation]}`;
}

/** Título da folha de tipos. */
export function relationSheetTitle(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  return n ? `Quem é ${n}?` : "Quem é este contato?";
}

export const RELATION_SHEET_HINT =
  "Quem não é cliente: a IA não responde e o lead sai do funil. Dá para desfazer.";

/**
 * Desfazer: volta ao tipo anterior. Voltando para Lead (ou sem tipo) depois de
 * marcar como não-cliente, pede para restaurar o lead arquivado pela marcação.
 */
export function undoArgs(
  previous: ContactRelation | null | undefined,
  applied: ContactRelation | null
): { relation: ContactRelation | null; restoreLead?: boolean } {
  const prev = previous ?? null;
  const backToBusiness = !offBusinessRelation(prev) && !!offBusinessRelation(applied);
  return backToBusiness ? { relation: prev, restoreLead: true } : { relation: prev };
}

// ---------------------------------------------------------------------------
// "Marcado por …"
// ---------------------------------------------------------------------------

const SOURCE_TEXT: Record<ContactRelationSource, string> = {
  manual: "pelo app",
  import: "por importação",
  suggestion: "por sugestão",
  telegram: "pelo Telegram",
  api: "por integração",
  team_phone: "por ser número da equipe",
  ops: "pelo suporte",
};

export interface RelationMeta {
  setAt: number;
  setBy?: string;
  source?: string;
}

/** "Marcado por Kenji em 18/11/2026 (pelo Telegram)". Sem meta = `null`. */
export function relationMetaLine(meta: RelationMeta | null | undefined, memberName?: string | null): string | null {
  if (!meta || typeof meta.setAt !== "number") return null;
  const who = memberName?.trim() ? ` por ${memberName.trim()}` : "";
  const source = meta.source ? SOURCE_TEXT[meta.source as ContactRelationSource] : undefined;
  return `Marcado${who} em ${formatDate(meta.setAt)}${source ? ` (${source})` : ""}`;
}

// ---------------------------------------------------------------------------
// Pedido de tipo vindo do servidor (`needs_relation`)
// ---------------------------------------------------------------------------

/**
 * `returnToAi`, rejeitar repasse e `requestAiDraft` num contato que não é
 * cliente devolvem `{ needsRelation: true, relation }` ou lançam
 * `ConvexError({ code: "needs_relation", relation })`. Lê os dois formatos
 * (também o `data` de um erro) e devolve o tipo atual; senão `null`.
 */
export function needsRelationFrom(value: unknown): ContactRelation | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { needsRelation?: unknown; code?: unknown; relation?: unknown; data?: unknown };
  if (v.needsRelation === true || v.code === NEEDS_RELATION_CODE) {
    return asContactRelation(v.relation) ?? "personal";
  }
  if (v.data !== undefined && v.data !== value) return needsRelationFrom(v.data);
  return null;
}

/** Texto do diálogo "Virar lead e devolver à IA". */
export function needsRelationText(name: string | null | undefined, relation: ContactRelation): string {
  const n = (name ?? "").trim() || "Este contato";
  return `${n} está como ${CONTACT_RELATION_LABEL[relation]}. A IA não responde contatos que não são clientes.`;
}

/** Parâmetro do deep link que abre a folha de tipos (`?conversation=…&marcar=1`). */
export const MARK_PARAM = "marcar";

