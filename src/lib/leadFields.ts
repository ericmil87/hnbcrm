/**
 * Regras puras dos campos do lead no painel de detalhe: datas de campo
 * personalizado, qualificação (antigo BANT), detalhes básicos e edição de
 * `customFields`. Sem Convex nem React.
 */

export type LeadPriority = "low" | "medium" | "high" | "urgent";
export type LeadTemperature = "cold" | "warm" | "hot";

export type LeadFieldDefinition = {
  _id: string;
  name: string;
  key: string;
  type: "text" | "number" | "boolean" | "date" | "select" | "multiselect";
  entityType?: "lead" | "contact";
  options?: string[];
  isRequired: boolean;
  order: number;
};

/**
 * `customFields` guarda datas como timestamp (ms) OU string: a leitura aceita
 * os dois e devolve `YYYY-MM-DD` (hora local) para o `<input type="date">`.
 */
export function toDateInputValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const d = typeof value === "number" ? new Date(value) : new Date(String(value));
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `YYYY-MM-DD` -> timestamp (ms) da meia-noite local; vazio ou inválido -> `undefined`. A escrita sempre grava timestamp. */
export function fromDateInputValue(raw: string): number | undefined {
  if (!raw) return undefined;
  const [y, m, d] = raw.split("-").map(Number);
  if (![y, m, d].every(Number.isFinite)) return undefined;
  return new Date(y, m - 1, d).getTime();
}

/** Lead sem `entityType` é legado (campo criado antes da separação) e vale para lead. */
export function leadFieldDefinitions(defs: readonly LeadFieldDefinition[]): LeadFieldDefinition[] {
  return defs
    .filter((f) => f.entityType === "lead" || f.entityType === undefined)
    .sort((a, b) => a.order - b.order);
}

/** Copia de `values` com `key` trocado; `undefined` remove a chave. */
export function setCustomFieldValue(
  values: Record<string, unknown>,
  key: string,
  value: unknown
): Record<string, unknown> {
  const next = { ...values };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/** Liga/desliga uma opção de um campo de múltipla escolha; lista vazia remove a chave. */
export function toggleCustomFieldOption(
  values: Record<string, unknown>,
  key: string,
  option: string
): Record<string, unknown> {
  const current = Array.isArray(values[key]) ? (values[key] as string[]) : [];
  const list = current.includes(option) ? current.filter((o) => o !== option) : [...current, option];
  const next = { ...values };
  if (list.length > 0) next[key] = list;
  else delete next[key];
  return next;
}

/* ------------------------------------------------------------------ */
/*  Qualificação (critérios BANT, que a interface chama de "Qualificação") */
/* ------------------------------------------------------------------ */

export const QUALIFICATION_CRITERIA = [
  { key: "budget", label: "Orçamento", desc: "O prospect tem verba disponível?" },
  { key: "authority", label: "Autoridade", desc: "Está falando com o decisor?" },
  { key: "need", label: "Necessidade", desc: "Existe uma dor real a resolver?" },
  { key: "timeline", label: "Prazo", desc: "Há urgência ou prazo definido?" },
] as const;

export type QualificationKey = (typeof QUALIFICATION_CRITERIA)[number]["key"];
export type QualificationState = Record<QualificationKey, boolean>;

export const QUALIFICATION_MAX = QUALIFICATION_CRITERIA.length;

export const EMPTY_QUALIFICATION: QualificationState = {
  budget: false,
  authority: false,
  need: false,
  timeline: false,
};

/** Estado a partir de `lead.qualification` (ausente = tudo desmarcado). */
export function qualificationFromLead(
  q: Partial<Record<QualificationKey, boolean>> | null | undefined
): QualificationState {
  return {
    budget: q?.budget ?? false,
    authority: q?.authority ?? false,
    need: q?.need ?? false,
    timeline: q?.timeline ?? false,
  };
}

/** Quantos critérios estão marcados (0 a 4). */
export function qualificationScore(state: QualificationState): number {
  return QUALIFICATION_CRITERIA.filter((c) => state[c.key]).length;
}

/** Argumento `qualification` de `updateLeadQualification`: os 4 critérios mais a pontuação. */
export function toQualificationPayload(state: QualificationState) {
  return { ...state, score: qualificationScore(state) };
}

/** Faixa da pontuação: 4 = sucesso, 2 ou 3 = atenção, 1 = baixa, 0 = neutra. */
export function qualificationTone(score: number): "success" | "warning" | "error" | "muted" {
  if (score >= QUALIFICATION_MAX) return "success";
  if (score >= 2) return "warning";
  if (score >= 1) return "error";
  return "muted";
}

/* ------------------------------------------------------------------ */
/*  Detalhes básicos                                                    */
/* ------------------------------------------------------------------ */

export interface LeadDetailsForm {
  title: string;
  value: number;
  priority: LeadPriority;
  temperature: LeadTemperature;
  /** Texto separado por vírgula, como digitado. */
  tags: string;
}

/** "enterprise, urgente,, " -> ["enterprise", "urgente"]. */
export function parseLeadTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Mensagem de erro do formulário de detalhes, ou `null` quando pode salvar. */
export function validateLeadDetails(form: Pick<LeadDetailsForm, "title" | "value">): string | null {
  if (!form.title.trim()) return "Informe o título do lead.";
  if (!Number.isFinite(form.value) || form.value < 0) return "O valor não pode ser negativo.";
  return null;
}

/** Argumentos de `updateLead` (sem `leadId`) a partir do formulário. */
export function toLeadDetailsUpdate(form: LeadDetailsForm) {
  return {
    title: form.title.trim(),
    value: form.value,
    priority: form.priority,
    temperature: form.temperature,
    tags: parseLeadTags(form.tags),
  };
}
