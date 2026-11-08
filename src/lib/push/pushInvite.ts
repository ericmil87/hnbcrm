import { detectArrivals, seedWatermark, type ArrivalItem } from "@/lib/notificationInbox";

/** Convite contextual para ativar avisos no aparelho: nunca na carga, no máximo 1× a cada 7 dias. */
export const PUSH_INVITE_KEY = "hnbcrm.push.inviteAt";
export const PUSH_INVITE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export function readInviteAt(): number | null {
  try {
    const raw = localStorage.getItem(PUSH_INVITE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function markInviteShown(now: number): void {
  try {
    localStorage.setItem(PUSH_INVITE_KEY, String(now));
  } catch {
    /* sem localStorage: o chamador também guarda "já mostrei" em memória */
  }
}

export function shouldInvite(input: { status: string; lastShownAt: number | null; now: number; shownThisSession: boolean }): boolean {
  // "needs-install" (iPhone fora da Tela de Início) recebe o convite para instalar o app.
  if (input.status !== "default" && input.status !== "needs-install") return false;
  if (input.shownThisSession) return false;
  if (input.lastShownAt !== null && input.now - input.lastShownAt < PUSH_INVITE_COOLDOWN_MS) return false;
  return true;
}

/** Tipos que justificam o convite: pedido de ajuda e mensagem atribuída a mim. */
export const PUSH_INVITE_TYPES: ReadonlySet<string> = new Set(["handoff_requested", "new_message", "conversation_transferred"]);

/**
 * Observa a janela de não lidas: a 1ª leitura só semeia a marca d'água (nunca convida na carga);
 * depois, uma chegada de pedido de ajuda/mensagem atribuída convida (respeitando o intervalo de 7 dias).
 */
export function planInvite(args: {
  watermark: number | null;
  items: readonly ArrivalItem[];
  openConversationId: string | null;
  status: string;
  lastShownAt: number | null;
  now: number;
  shownThisSession: boolean;
}): { invite: boolean; nextWatermark: number } {
  if (args.watermark === null) return { invite: false, nextWatermark: seedWatermark(args.items) };
  const { arrivals, nextWatermark } = detectArrivals(args.watermark, args.items, args.openConversationId);
  const relevant = arrivals.some((n) => PUSH_INVITE_TYPES.has(n.type));
  const invite =
    relevant && shouldInvite({ status: args.status, lastShownAt: args.lastShownAt, now: args.now, shownThisSession: args.shownThisSession });
  return { invite, nextWatermark };
}
