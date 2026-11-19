import {
  CONTACT_RELATION_LABEL,
  asContactRelation,
  offBusinessRelation,
  type ContactRelation,
} from "./contactRelationUi";
import {
  matchesContactRelationFilter,
  type ContactRelationFilter,
} from "../../convex/lib/contactRelationFilter";

// Lógica pura de "Ver e filtrar" por tipo de contato (PR2, sem React): filtro
// por tipo (arg `relation` do servidor e `?tipo=` da URL), selo da linha
// (bolinha colorida + nome, estilo etiqueta do WhatsApp Web), estado vazio por
// filtro e o modelo das ações em lote ("Não é cliente" / "Virar lead").
// Testada em `contactRelationList.test.ts`.

// ---------------------------------------------------------------------------
// Filtro por tipo
// ---------------------------------------------------------------------------

/**
 * Valores do arg `relation` de `conversations.getConversations` e da lista de
 * Contatos. "leads" = cliente + sem tipo; "personal" = qualquer não-cliente;
 * "none" = sem tipo. "customer" existe no servidor, mas a tela não o oferece.
 */
export type RelationFilter = Exclude<ContactRelationFilter, "customer">;

/** `?tipo=` (PT-BR na URL) ↔ arg do servidor. */
export const RELATION_PARAM: Record<RelationFilter, string> = {
  leads: "leads",
  personal: "pessoais",
  team: "equipe",
  supplier: "fornecedores",
  partner: "parceiros",
  automated: "robos",
  none: "semtipo",
};

const FILTER_BY_PARAM: Record<string, RelationFilter> = Object.fromEntries(
  (Object.entries(RELATION_PARAM) as [RelationFilter, string][]).map(([filter, param]) => [param, filter])
);

/** Valores aceitos em `?tipo=` ("" = sem filtro), para o `enumParam`. */
export const RELATION_PARAM_VALUES = ["", ...Object.values(RELATION_PARAM)] as const;

/** `?tipo=` → filtro; ausente ou lixo = `null`. */
export function relationFilterFromParam(param: string | null | undefined): RelationFilter | null {
  return (param && FILTER_BY_PARAM[param]) || null;
}

/** Filtro → `?tipo=` (`null` some da URL). */
export function relationParamFromFilter(filter: RelationFilter | null): string | null {
  return filter ? RELATION_PARAM[filter] : null;
}

/** Rótulo do chip/opção do filtro (plural: é um grupo de conversas). */
export const RELATION_FILTER_LABEL: Record<RelationFilter, string> = {
  leads: "Leads",
  personal: "Pessoais",
  team: "Equipe",
  supplier: "Fornecedores",
  partner: "Parceiros",
  automated: "Robôs",
  none: "Sem tipo",
};

/** Os dois filtros da fileira principal de chips. */
export const MAIN_RELATION_FILTERS: readonly RelationFilter[] = ["leads", "personal"];

/** Os demais, em "Mais filtros" › Tipo (no desktop) — um escolhido vira chip com ✕. */
export const MORE_RELATION_FILTERS: readonly RelationFilter[] = ["team", "supplier", "partner", "automated", "none"];

/** Chips da página Contatos (Todos · Leads · Pessoais · Sem tipo). */
export const CONTACTS_RELATION_FILTERS: readonly RelationFilter[] = ["leads", "personal", "none"];

/** Arg do servidor (`{ relation }` ou `{}`: sem filtro a query não muda). */
export function relationArgs(filter: RelationFilter | null): { relation?: RelationFilter } {
  return filter ? { relation: filter } : {};
}

/**
 * Mesma regra do servidor (`matchesContactRelationFilter`), para listas já
 * carregadas (busca de Contatos, que não tem o arg): `relation` ausente = sem tipo.
 */
export function matchesRelationFilter(relation: unknown, filter: RelationFilter | null): boolean {
  return !filter || matchesContactRelationFilter(asContactRelation(relation), filter);
}

/** Estado vazio da lista de Conversas com o filtro de tipo ligado. */
export function relationEmptyMessage(filter: RelationFilter): { text: string; hint?: string } {
  const hint = "Use ⋮ › Não é cliente… numa conversa para marcar o contato.";
  switch (filter) {
    case "leads":
      return { text: "Nenhuma conversa com lead" };
    case "personal":
      return { text: "Nenhum contato pessoal", hint };
    case "team":
      return { text: "Nenhum contato da equipe", hint };
    case "supplier":
      return { text: "Nenhum fornecedor", hint };
    case "partner":
      return { text: "Nenhum parceiro", hint };
    case "automated":
      return { text: "Nenhum robô", hint };
    case "none":
      return { text: "Nenhum contato sem tipo" };
  }
}

/** Estado vazio da página Contatos com o filtro de tipo ligado. */
export function contactsRelationEmptyMessage(filter: RelationFilter): { title: string; hint: string } {
  switch (filter) {
    case "leads":
      return { title: "Nenhum lead", hint: "Contatos sem tipo ou marcados como Lead aparecem aqui." };
    case "personal":
      return {
        title: "Nenhum contato pessoal",
        hint: "Selecione contatos e use Definir tipo… para marcar quem não é cliente.",
      };
    case "none":
      return { title: "Nenhum contato sem tipo", hint: "Todos os contatos já têm um tipo." };
    default:
      return { title: `Nenhum contato em ${RELATION_FILTER_LABEL[filter]}`, hint: "Mude o filtro para ver outros contatos." };
  }
}

// ---------------------------------------------------------------------------
// Selo da linha
// ---------------------------------------------------------------------------

/**
 * Cor da bolinha por tipo (tokens do tema; nunca paleta crua). Lead não tem
 * selo (mostra a etapa), sem tipo também não.
 */
export const RELATION_DOT_CLASS: Record<Exclude<ContactRelation, "customer">, string> = {
  personal: "bg-semantic-info",
  team: "bg-brand-500",
  supplier: "bg-semantic-warning",
  partner: "bg-ai-500",
  automated: "bg-text-muted",
};

export interface RelationBadgeModel {
  relation: Exclude<ContactRelation, "customer">;
  label: string;
  dotClass: string;
}

/** Selo da 3ª linha ("● Pessoal") ou `null` (lead, sem tipo, valor desconhecido). */
export function relationBadge(relation: unknown): RelationBadgeModel | null {
  const off = offBusinessRelation(asContactRelation(relation));
  if (!off || off === "customer") return null;
  return { relation: off, label: CONTACT_RELATION_LABEL[off], dotClass: RELATION_DOT_CLASS[off] };
}

// ---------------------------------------------------------------------------
// Ações em lote
// ---------------------------------------------------------------------------

export interface BulkRelationRow {
  _id: string;
  kind?: string;
  contactRelation?: unknown;
  contact?: { _id?: string; relation?: unknown } | null;
}

export interface BulkRelationTargets {
  /** Contatos únicos das conversas 1:1 selecionadas (grupo não tem contato). */
  contactIds: string[];
  /** Tipo atual de cada contato (mesma ordem de `contactIds`; `null` = sem tipo). */
  previous: (ContactRelation | null)[];
  /** Todos fora do comercial: mostra "Virar lead". */
  allOffBusiness: boolean;
  /** Selecionadas que não entram (grupo, conversa sem contato). */
  skipped: number;
}

/** Contatos-alvo das conversas selecionadas (deduplicados: duas conversas do mesmo contato = um). */
export function bulkRelationTargets(rows: readonly BulkRelationRow[], selectedIds: ReadonlySet<string>): BulkRelationTargets {
  const contactIds: string[] = [];
  const previous: (ContactRelation | null)[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const row of rows) {
    if (!selectedIds.has(row._id)) continue;
    const contactId = row.kind === "group" ? undefined : row.contact?._id;
    if (!contactId) {
      skipped += 1;
      continue;
    }
    if (seen.has(contactId)) continue;
    seen.add(contactId);
    contactIds.push(contactId);
    previous.push(asContactRelation(row.contact?.relation) ?? asContactRelation(row.contactRelation) ?? null);
  }
  return {
    contactIds,
    previous,
    allOffBusiness: previous.length > 0 && previous.every((r) => !!offBusinessRelation(r)),
    skipped,
  };
}

/**
 * Tipo para o "Desfazer" do lote: só quando todos tinham o MESMO tipo antes
 * (senão um tipo único apagaria a diferença); `undefined` = sem "Desfazer".
 */
export function commonPreviousRelation(
  previous: readonly (ContactRelation | null | undefined)[]
): ContactRelation | null | undefined {
  if (previous.length === 0) return undefined;
  const first = previous[0] ?? null;
  return previous.every((r) => (r ?? null) === first) ? first : undefined;
}

/** Tipo comum da seleção para marcar na folha (misturado = nenhum). */
export function commonCurrentRelation(previous: readonly (ContactRelation | null)[]): ContactRelation | undefined {
  const common = commonPreviousRelation(previous);
  return common ?? undefined;
}

/** Título da folha de tipos no lote. */
export function bulkRelationSheetTitle(count: number): string {
  return count === 1 ? "Quem é este contato?" : `Quem são esses ${count} contatos?`;
}

/** Toast do lote: "3 contatos agora estão como Pessoal". */
export function bulkRelationChangedText(count: number, relation: ContactRelation | null): string {
  if (count === 1) {
    if (relation === "customer") return "1 contato agora é lead";
    if (relation === null) return "1 contato agora está sem tipo";
    return `1 contato agora está como ${CONTACT_RELATION_LABEL[relation]}`;
  }
  if (relation === "customer") return `${count} contatos agora são leads`;
  if (relation === null) return `${count} contatos agora estão sem tipo`;
  return `${count} contatos agora estão como ${CONTACT_RELATION_LABEL[relation]}`;
}

/** Um item do retorno de `contacts.bulkSetContactRelation`. */
export interface BulkRelationItem<C extends string = string, L extends string = string> {
  contactId: C;
  status: "changed" | "unchanged" | "not_found";
  previous: ContactRelation | null;
  archivedLeadIds: readonly L[];
}

export interface BulkUndoGroup<C extends string = string, L extends string = string> {
  relation: ContactRelation | null;
  contactIds: C[];
  /** SEMPRE enviado (mesmo vazio): lista explícita = desarquiva só estes, nunca cria/restaura outro lead. */
  restoreLeadIds: L[];
}

/**
 * "Desfazer" do lote: uma chamada por tipo anterior (só os itens `changed`),
 * com os leads que a marcação arquivou daqueles contatos. Vazio = nada a desfazer.
 */
export function bulkUndoGroups<C extends string, L extends string>(
  items: readonly BulkRelationItem<C, L>[]
): BulkUndoGroup<C, L>[] {
  const groups = new Map<string, BulkUndoGroup<C, L>>();
  for (const item of items) {
    if (item.status !== "changed") continue;
    const key = item.previous ?? "";
    const group = groups.get(key) ?? { relation: item.previous, contactIds: [], restoreLeadIds: [] };
    group.contactIds.push(item.contactId);
    group.restoreLeadIds.push(...item.archivedLeadIds);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Resumo do lote para o toast: quantos ficaram com o tipo e quantos não foram achados. */
export function bulkOutcome(result: { changed: number; unchanged: number; notFound: number }): {
  done: number;
  notFound: number;
} {
  return { done: result.changed + result.unchanged, notFound: result.notFound };
}

// ---------------------------------------------------------------------------
// Página Contatos
// ---------------------------------------------------------------------------

export interface RelationChip {
  /** "all" | filtro (`RelationFilter`). */
  id: "all" | RelationFilter;
  label: string;
  pressed: boolean;
  removable?: boolean;
}

/**
 * Chips de Contatos: Todos · Leads · Pessoais · Sem tipo. Um tipo vindo da URL
 * que não tem chip (ex.: `?tipo=equipe`) entra marcado com ✕ para poder sair.
 */
export function contactsRelationChips(filter: RelationFilter | null): RelationChip[] {
  const chips: RelationChip[] = [
    { id: "all", label: "Todos", pressed: !filter },
    ...CONTACTS_RELATION_FILTERS.map((id) => ({ id, label: RELATION_FILTER_LABEL[id], pressed: filter === id })),
  ];
  if (filter && !CONTACTS_RELATION_FILTERS.includes(filter)) {
    chips.push({ id: filter, label: RELATION_FILTER_LABEL[filter], pressed: true, removable: true });
  }
  return chips;
}

/** Próximo filtro ao tocar num chip de Contatos ("Todos" e o marcado desligam). */
export function nextContactsRelation(id: string, current: RelationFilter | null): RelationFilter | null {
  if (id === "all" || id === current) return null;
  return id in RELATION_PARAM ? (id as RelationFilter) : current;
}
