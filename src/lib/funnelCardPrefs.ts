/**
 * Preferência pessoal (por organização) de como o cartão do lead aparece no quadro do Funil.
 * Guardada em `localStorage`; nada disso vai para o servidor.
 */
export type FunnelCardDensity = "compact" | "comfortable";

export const FUNNEL_CARD_FIELDS = [
  "contact",
  "value",
  "priority",
  "temperature",
  "tags",
  "assignee",
  "age",
  "lastMessage",
] as const;

export type FunnelCardField = (typeof FUNNEL_CARD_FIELDS)[number];

export const FUNNEL_CARD_FIELD_LABELS: Record<FunnelCardField, string> = {
  contact: "Contato",
  value: "Valor",
  priority: "Prioridade",
  temperature: "Temperatura",
  tags: "Etiquetas",
  assignee: "Responsável",
  age: "Tempo na etapa",
  lastMessage: "Última mensagem",
};

export interface FunnelCardPrefs {
  density: FunnelCardDensity;
  fields: FunnelCardField[];
}

export const DEFAULT_FUNNEL_CARD_PREFS: FunnelCardPrefs = {
  density: "compact",
  fields: ["contact", "value", "priority", "temperature", "assignee", "age"],
};

export function funnelCardPrefsStorageKey(organizationId: string): string {
  return `hnbcrm.funnelCard.${organizationId}`;
}

export function defaultFunnelCardPrefs(): FunnelCardPrefs {
  return { density: DEFAULT_FUNNEL_CARD_PREFS.density, fields: [...DEFAULT_FUNNEL_CARD_PREFS.fields] };
}

function isField(value: unknown): value is FunnelCardField {
  return typeof value === "string" && (FUNNEL_CARD_FIELDS as readonly string[]).includes(value);
}

/** Lê o valor guardado; qualquer lixo cai no padrão, campo desconhecido é ignorado. */
export function parseFunnelCardPrefs(raw: string | null | undefined): FunnelCardPrefs {
  const fallback = defaultFunnelCardPrefs();
  if (!raw) return fallback;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return fallback;
  const { density, fields } = data as { density?: unknown; fields?: unknown };
  return {
    density: density === "compact" || density === "comfortable" ? density : fallback.density,
    fields: Array.isArray(fields)
      ? FUNNEL_CARD_FIELDS.filter((f) => fields.includes(f))
      : fallback.fields,
  };
}

export function serializeFunnelCardPrefs(prefs: FunnelCardPrefs): string {
  return JSON.stringify({ density: prefs.density, fields: prefs.fields.filter(isField) });
}

export function isFieldVisible(prefs: Pick<FunnelCardPrefs, "fields">, field: FunnelCardField): boolean {
  return prefs.fields.includes(field);
}

/** Liga ou desliga um campo mantendo a ordem canônica. */
export function toggleFunnelCardField(prefs: FunnelCardPrefs, field: FunnelCardField, on: boolean): FunnelCardPrefs {
  return {
    ...prefs,
    fields: FUNNEL_CARD_FIELDS.filter((f) => (f === field ? on : prefs.fields.includes(f))),
  };
}
