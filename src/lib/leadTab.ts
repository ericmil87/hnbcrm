import type { ParamCodec } from "./searchParamState";

export const LEAD_TABS = ["conversation", "details", "tasks", "campaigns", "activity"] as const;
export type LeadTab = (typeof LEAD_TABS)[number];

export const DEFAULT_LEAD_TAB: LeadTab = "conversation";

/**
 * Codec de `?leadTab=`: valor inválido ou ausente = `null` (quem lê cai na aba
 * inicial do chamador). Sempre escreve o valor, inclusive `conversation`,
 * porque a aba inicial pode ser outra (`initialTab`).
 */
export const LEAD_TAB_PARAM: ParamCodec<LeadTab | null> = {
  parse: (raw) => ((LEAD_TABS as readonly string[]).includes(raw ?? "") ? (raw as LeadTab) : null),
  serialize: (value) => value,
};

/**
 * A aba só vai para a URL quando o painel foi aberto por `?lead=<este lead>`
 * (Funil). Aberto por estado local (dentro do contato, overlay de Conversas) a
 * aba fica local: `leadTab` nunca é escrito sem `lead` na URL.
 */
export function isLeadTabInUrl(leadParam: string | null, leadId: string): boolean {
  return leadParam !== null && leadParam === leadId;
}

/** Aba efetiva: a da URL (se o painel é da URL e ela é válida) ou a local. */
export function resolveLeadTab(opts: {
  inUrl: boolean;
  urlTab: LeadTab | null;
  localTab: LeadTab;
  initialTab?: LeadTab;
}): LeadTab {
  if (opts.inUrl) return opts.urlTab ?? opts.initialTab ?? DEFAULT_LEAD_TAB;
  return opts.localTab;
}
