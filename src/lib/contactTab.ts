import { enumParam } from "./searchParamState";

export const CONTACT_TABS = ["info", "leads", "groups"] as const;
export type ContactTab = (typeof CONTACT_TABS)[number];

/** Codec constante de `?contactTab=` (`info` é o padrão e sai da URL). */
export const CONTACT_TAB_PARAM = enumParam<ContactTab>(CONTACT_TABS, "info");

/**
 * A aba só vai para a URL quando o painel foi aberto por `?contact=` deste
 * contato (página Contatos). Aberto como overlay (Conversas, Grupos, lead) a
 * aba fica local: `contactTab` nunca é escrito sem `contact` na URL.
 */
export function isContactTabInUrl(contactParam: string | null, contactId: string): boolean {
  return contactParam !== null && contactParam === contactId;
}
