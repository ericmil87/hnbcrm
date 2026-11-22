/**
 * Seletor de cliente da Agenda v2 (B3). Cópia IDÊNTICA de `formatPhone` (`campaigns/campaignUtils`), de propósito:
 * importar `campaignUtils` daqui fazia o rollup tirar esse módulo do chunk de Campanhas e pendurá-lo como chunk
 * compartilhado de Entrada, Contatos, Grupos e Funil (cresciam todos). `agendaClientPicker.test` confere a igualdade.
 */
export function formatClientPhone(phone: string): string {
  // 5511999991234 -> +55 11 99999-1234
  if (phone.startsWith("55") && (phone.length === 12 || phone.length === 13)) {
    const ddd = phone.slice(2, 4);
    const rest = phone.slice(4);
    const split = rest.length === 9 ? 5 : 4;
    return `+55 ${ddd} ${rest.slice(0, split)}-${rest.slice(split)}`;
  }
  return `+${phone}`;
}

/** O que `contacts.searchContacts` devolve de cada contato (o documento): o nome vem em `firstName`/`lastName`. */
export interface ClientCandidate {
  _id: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  whatsappNumber?: string | null;
  email?: string | null;
}

/**
 * Nome do contato na busca de cliente: `firstName` + `lastName`, como o resto do app (`joinContactName` de
 * `contactName.ts`; cópia pelo mesmo motivo de `formatClientPhone`, com teste de igualdade). Vazio = sem nome.
 * A tela lia um campo `name` que o contato não tem, e todo mundo aparecia como "Sem nome".
 */
export function clientCandidateName(c: Pick<ClientCandidate, "firstName" | "lastName">): string {
  return `${c.firstName ?? ""} ${c.lastName ?? ""}`.replace(/\s+/g, " ").trim();
}

/** Linha de baixo do resultado: telefone (ou o WhatsApp) formatado, senão o e-mail. */
export function clientCandidateSub(c: Pick<ClientCandidate, "phone" | "whatsappNumber" | "email">): string {
  const phone = (c.phone || c.whatsappNumber || "").replace(/^\+/, "");
  return phone ? formatClientPhone(phone) : (c.email ?? "");
}
