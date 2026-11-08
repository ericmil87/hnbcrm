/**
 * Estado de tela compartilhado entre o sino (NotificationBell), o hook de chegadas e o convite do push
 * (PushLifecycle): painel aberto, pausa ativa e a hora do último toast de chegada. Fora do React de propósito:
 * o convite só consulta na hora de decidir. As decisões são puras e testadas.
 */

/** O convite espera este tempo sem toasts de chegada para não empilhar com eles. */
export const INVITE_QUIET_MS = 8000;
/** Com o sino aberto ou a pausa ativa o convite só tenta de novo depois deste intervalo. */
export const INVITE_RETRY_MS = 3000;

export interface NotificationUiState {
  bellOpen: boolean;
  paused: boolean;
  lastArrivalAt: number | null;
}

const state: NotificationUiState = { bellOpen: false, paused: false, lastArrivalAt: null };

export function getNotificationUiState(): Readonly<NotificationUiState> {
  return state;
}
export function setBellOpen(open: boolean): void {
  state.bellOpen = open;
}
export function setNotificationsPaused(paused: boolean): void {
  state.paused = paused;
}
export function markArrivalToast(now: number): void {
  state.lastArrivalAt = now;
}
export function resetNotificationUiState(): void {
  state.bellOpen = false;
  state.paused = false;
  state.lastArrivalAt = null;
}

/** Toast e som de chegada: calados com a pausa ativa (o sino segue registrando) e com o painel aberto. */
export function shouldAnnounceArrival(input: { paused: boolean; suppressed: boolean }): boolean {
  return !input.paused && !input.suppressed;
}

/** Quanto esperar antes de mostrar o convite: 0 = agora; senão o atraso até a próxima tentativa. */
export function inviteWaitMs(input: { bellOpen: boolean; paused: boolean; lastArrivalAt: number | null; now: number }): number {
  if (input.bellOpen || input.paused) return INVITE_RETRY_MS;
  if (input.lastArrivalAt === null) return 0;
  return Math.max(0, input.lastArrivalAt + INVITE_QUIET_MS - input.now);
}
