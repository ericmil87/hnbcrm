/**
 * Seletor de cliente da Agenda v2 (B3). Cópia mínima de `formatPhone` (`campaigns/campaignUtils`) de
 * propósito: importar `campaignUtils` daqui fazia o rollup tirar esse módulo do chunk de Campanhas e
 * pendurá-lo como chunk compartilhado de Entrada, Contatos, Grupos e Funil (cresciam todos).
 */
export function formatClientPhone(phone: string): string {
  const digits = phone.replace(/^\+/, "");
  // 5511999991234 -> +55 11 99999-1234
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    const split = rest.length === 9 ? 5 : 4;
    return `+55 ${ddd} ${rest.slice(0, split)}-${rest.slice(split)}`;
  }
  return `+${digits}`;
}
