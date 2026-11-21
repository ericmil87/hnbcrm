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
