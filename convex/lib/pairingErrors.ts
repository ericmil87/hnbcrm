/**
 * Traduz o erro técnico de um passo de pareamento (gateway, rede, HTTP) para uma
 * mensagem curta em PT-BR segura para o cliente. O detalhe cru nunca sai daqui:
 * quem chama registra com console.warn.
 */
export const PAIRING_ERROR_COPY = {
  unreachable: "Não foi possível falar com o serviço de conexão. Tente de novo em instantes.",
  invalidNumber: "Número inválido ou não suportado. Confira o DDI e o número.",
  rateLimited: "Muitas tentativas em pouco tempo. Aguarde um pouco e tente de novo.",
  incomplete: "Este canal está com a configuração incompleta. Reconfigure o canal e tente de novo.",
  unknown: "Não foi possível gerar o código de conexão. Tente de novo.",
} as const;

export function friendlyPairingError(raw: string | undefined): string {
  const e = (raw ?? "").toLowerCase();
  if (!e) return PAIRING_ERROR_COPY.unknown;
  if (e === "sem_telefone" || /invalid.*(phone|number)|phone.*invalid|not.*(on|registered).*whatsapp|unsupported|número inválido|numero invalido/.test(e)) {
    return PAIRING_ERROR_COPY.invalidNumber;
  }
  if (/http 429|rate.?limit|too many|quota/.test(e)) return PAIRING_ERROR_COPY.rateLimited;
  if (/configuração bridge incompleta|configuracao bridge incompleta/.test(e)) return PAIRING_ERROR_COPY.incomplete;
  if (/http (5\d\d|40[1348])|fetch|network|timeout|timed out|abort|econn|enotfound|socket|unreachable|gateway|failed to/.test(e)) {
    return PAIRING_ERROR_COPY.unreachable;
  }
  return PAIRING_ERROR_COPY.unknown;
}
