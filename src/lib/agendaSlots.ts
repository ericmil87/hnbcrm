/**
 * Agenda v2: leitura de um horário oferecido (`Slot` do servidor). PURO.
 *
 * "Encostado" = o horário fica colado em outro atendimento. O servidor manda `reasonCodes` (código `ADJACENT`,
 * de `SCORE_REASON_CODES`); a função usa os códigos e o texto PT-BR ("logo após outro atendimento") fica só
 * como reserva (resposta antiga, sem códigos). É a ÚNICA função que decide isso no front.
 */
export interface SlotReasons {
  reasons: ReadonlyArray<string>;
  /** Códigos estruturados do servidor (`Slot.reasonCodes`). */
  reasonCodes?: ReadonlyArray<string>;
}

export const ADJACENT_REASON_CODE = "ADJACENT";
const ADJACENT_TEXT = /^logo (após|antes de) outro atendimento/;

export function slotTouchesAnother(slot: SlotReasons): boolean {
  if (slot.reasonCodes && slot.reasonCodes.length > 0) return slot.reasonCodes.includes(ADJACENT_REASON_CODE);
  return slot.reasons.some((r) => ADJACENT_TEXT.test(r));
}
