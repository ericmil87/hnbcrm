/**
 * Layout do thread de mensagens estilo WhatsApp (puro, sem React):
 * - agrupa mensagens consecutivas do mesmo remetente (mesmo dia, até 5 min
 *   entre uma e outra) num "bloco": a 1ª ganha a cauda e o espaço maior;
 * - decide quando o rótulo do remetente aparece (só quando informa algo);
 * - marca onde entra o separador de dia.
 * O componente (`inbox/ConversationThread.tsx`) só aplica as classes.
 */

/** Intervalo máximo entre duas mensagens do mesmo bloco. */
export const RUN_GAP_MS = 5 * 60_000;

/** O que o layout lê de uma mensagem (subconjunto de `InboxMessage`). */
export interface LayoutMessage {
  _id: string;
  direction: string;
  senderType: string;
  isInternal: boolean;
  createdAt: number;
  senderId?: string | null;
  senderLid?: string;
  senderPhone?: string;
  senderName?: string;
  metadata?: Record<string, unknown>;
}

export type SenderLabelKind =
  /** Membro de uma sala de grupo (nome colorido). */
  | "group"
  /** Resposta da IA: "IA · <nome>". */
  | "ai"
  /** Outro membro da equipe (não quem está olhando). */
  | "team"
  /** Nota interna: sempre identificada. */
  | "note";

export interface LabelContext {
  isGroup: boolean;
  /** Membro da equipe que está vendo a conversa (suas mensagens não levam nome). */
  currentMemberId?: string | null;
}

const isInboundMessage = (m: LayoutMessage) => m.direction === "inbound" || m.senderType === "contact";

/**
 * Quem "fala" na bolha, para agrupar. Notas internas formam blocos próprios
 * (mesmo autor), IA é um remetente só, mensagem vinda do aparelho também.
 */
export function senderKey(m: LayoutMessage): string {
  if (m.isInternal) return `note:${m.senderId ?? ""}`;
  if (isInboundMessage(m)) return `in:${m.senderLid ?? m.senderPhone ?? m.senderName ?? ""}`;
  if (m.senderType === "ai") return `ai:${m.senderId ?? ""}`;
  if (m.metadata?.via === "device") return "device";
  return `team:${m.senderId ?? ""}`;
}

/**
 * Tipo de rótulo de remetente que a bolha PODE levar (null = nunca leva):
 * na conversa 1 a 1 o nome do contato já está no cabeçalho, e o que o próprio
 * operador enviou dispensa nome. O thread ainda corta o rótulo nas bolhas que
 * não abrem um bloco (`showSender`).
 */
export function senderLabelKind(m: LayoutMessage, ctx: LabelContext): SenderLabelKind | null {
  if (m.isInternal) return "note";
  if (isInboundMessage(m)) return ctx.isGroup ? "group" : null;
  if (m.senderType === "ai") return "ai";
  if (m.metadata?.via === "device") return null;
  if (!m.senderId) return null;
  if (ctx.currentMemberId && m.senderId === ctx.currentMemberId) return null;
  return "team";
}

export interface BubbleLayout {
  /** Primeira do bloco: cauda, espaço maior acima e (se couber) o rótulo. */
  first: boolean;
  /** Última do bloco. */
  last: boolean;
  /** Mostra o nome do remetente. */
  showSender: boolean;
  /** Entra um separador de dia antes deste item (o 1º item sempre tem). */
  daySeparator: boolean;
}

/** Dia de calendário local ("2026-11-06"), para o separador. */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * Layout de cada item do thread, na ordem recebida. `isBubble(m) === false`
 * (evento de transferência, rascunho da IA) quebra o bloco: a bolha seguinte
 * abre um bloco novo.
 */
export function layoutThread<M extends LayoutMessage>(
  messages: readonly M[],
  ctx: LabelContext & { isBubble?: (m: M) => boolean; dayKey?: (ts: number) => string }
): BubbleLayout[] {
  const isBubble = ctx.isBubble ?? (() => true);
  const dayKey = ctx.dayKey ?? localDayKey;
  const out: BubbleLayout[] = [];
  const continues = (prev: M | undefined, cur: M | undefined): boolean =>
    !!prev &&
    !!cur &&
    isBubble(prev) &&
    isBubble(cur) &&
    senderKey(prev) === senderKey(cur) &&
    dayKey(prev.createdAt) === dayKey(cur.createdAt) &&
    cur.createdAt - prev.createdAt <= RUN_GAP_MS;

  messages.forEach((cur, i) => {
    const prev = i > 0 ? messages[i - 1] : undefined;
    const next = messages[i + 1];
    const first = !continues(prev, cur);
    out.push({
      first,
      last: !continues(cur, next),
      showSender: first && isBubble(cur) && senderLabelKind(cur, ctx) !== null,
      daySeparator: !prev || dayKey(prev.createdAt) !== dayKey(cur.createdAt),
    });
  });
  return out;
}
