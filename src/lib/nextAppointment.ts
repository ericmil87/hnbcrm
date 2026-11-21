/**
 * "Próximo horário" do chip da conversa: só o que ainda vai acontecer (aguardando aprovação, marcado ou
 * confirmado) e começa DEPOIS do minuto atual. Um atendimento das 15:00 já atendido ou que já começou
 * às 15:40 não é "próximo". Sem dependências (entra no pacote de todas as telas).
 */
export const UPCOMING_STATUSES: readonly string[] = ["pending_approval", "scheduled", "confirmed"];

export interface NextCandidate {
  status: string;
  startTime: number;
}

/** O mais próximo (menor início) que ainda não começou, ou `undefined`. `list` pode vir em qualquer ordem. */
export function pickNextAppointment<T extends NextCandidate>(list: readonly T[], now: number): T | undefined {
  let best: T | undefined;
  for (const a of list) {
    if (!UPCOMING_STATUSES.includes(a.status) || a.startTime <= now) continue;
    if (!best || a.startTime < best.startTime) best = a;
  }
  return best;
}

/** Quantos além do primeiro (para o "+2" do chip). */
export function countUpcoming(list: readonly NextCandidate[], now: number): number {
  return list.filter((a) => UPCOMING_STATUSES.includes(a.status) && a.startTime > now).length;
}
