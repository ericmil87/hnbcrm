/**
 * Agenda v2: leitura de um horário oferecido (`Slot` do servidor). PURO.
 *
 * "Encostado" = o horário fica colado em outro atendimento. HOJE o servidor só descreve o motivo em texto
 * PT-BR ("logo após outro atendimento"); quando ele passar a mandar `reasonCodes` (código `ADJACENT`), a
 * função usa os códigos e o texto vira só reserva. É a ÚNICA função que decide isso no front.
 */
export interface SlotReasons {
  reasons: ReadonlyArray<string>;
  /** Formato futuro do servidor. */
  reasonCodes?: ReadonlyArray<string>;
}

export const ADJACENT_REASON_CODE = "ADJACENT";
const ADJACENT_TEXT = /^logo (após|antes de) outro atendimento/;

export function slotTouchesAnother(slot: SlotReasons): boolean {
  if (slot.reasonCodes && slot.reasonCodes.length > 0) return slot.reasonCodes.includes(ADJACENT_REASON_CODE);
  return slot.reasons.some((r) => ADJACENT_TEXT.test(r));
}
