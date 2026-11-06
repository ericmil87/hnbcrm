/**
 * Regras puras do composer de Conversas (usado no Inbox e na aba Conversa do
 * lead). Sem React nem Convex: o `ComposerView` só apresenta o que sai daqui.
 */
import { isMediaPlaceholder, isVoiceNote, type InboxMessage } from "@/components/inbox/types";

export type OutgoingContentType = "text" | "image" | "audio" | "file";

/**
 * O tipo vem do primeiro arquivo anexado: o bridge só envia um anexo por
 * mensagem, então o primeiro decide a classificação.
 */
export function deriveContentType(files: readonly { mimeType: string }[]): OutgoingContentType {
  const first = files[0];
  if (!first) return "text";
  if (first.mimeType.startsWith("image/")) return "image";
  if (first.mimeType.startsWith("audio/")) return "audio";
  return "file";
}

/** Pré-visualização compacta da mensagem citada na barra "Respondendo". */
export function replyPreviewText(replyTo: InboxMessage | null): string {
  if (!replyTo) return "";
  if (replyTo.content && !isMediaPlaceholder(replyTo.content)) return replyTo.content;
  return isVoiceNote(replyTo) ? "Mensagem de voz" : "Mídia";
}

export function replyAuthorLabel(replyTo: InboxMessage | null, contactName: string): string {
  if (!replyTo) return "";
  return replyTo.direction === "inbound" || replyTo.senderType === "contact" ? contactName || "Contato" : "Você";
}

/** Enter envia; Shift+Enter quebra a linha (e Enter durante composição IME não conta). */
export function isSendKey(e: { key: string; shiftKey: boolean; nativeEvent?: { isComposing?: boolean } }): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.nativeEvent?.isComposing;
}

/**
 * Tecla de envio conforme o aparelho. No celular/tablet (ponteiro "coarse") o
 * Enter quebra a linha, como no WhatsApp: só o botão envia (Ctrl/Cmd+Enter de
 * um teclado físico ainda envia). No desktop vale `isSendKey`.
 */
export function isSendKeyFor(
  e: { key: string; shiftKey: boolean; ctrlKey?: boolean; metaKey?: boolean; nativeEvent?: { isComposing?: boolean } },
  coarsePointer: boolean
): boolean {
  if (!isSendKey(e)) return false;
  return coarsePointer ? !!(e.ctrlKey || e.metaKey) : true;
}

/** Linhas máximas do campo antes de rolar: celular 6, desktop 10. */
export function composerMaxRows(isDesktop: boolean): number {
  return isDesktop ? 10 : 6;
}

/**
 * Altura de um textarea que cresce com o texto: `scrollHeight` (conteúdo +
 * padding) limitado a `maxRows` linhas; acima disso o campo rola por dentro.
 */
export function autoGrowHeight(opts: {
  scrollHeight: number;
  lineHeight: number;
  paddingY: number;
  borderY?: number;
  rows?: number;
  maxRows: number;
}): { height: number; scrollable: boolean } {
  const { scrollHeight, lineHeight, paddingY, borderY = 0, rows = 1, maxRows } = opts;
  const min = lineHeight * Math.max(1, rows) + paddingY + borderY;
  const max = lineHeight * Math.max(Math.max(1, rows), maxRows) + paddingY + borderY;
  const wanted = Math.max(scrollHeight + borderY, min);
  return wanted > max ? { height: max, scrollable: true } : { height: wanted, scrollable: false };
}

export function hasContentToSend(text: string, stagedCount: number): boolean {
  return text.trim().length > 0 || stagedCount > 0;
}

/** Valor de um `datetime-local` (hora local, sem fuso). */
export function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Sugestão de agendamento: a próxima hora cheia depois de uma hora. */
export function defaultScheduleValue(now: number): string {
  const d = new Date(now + 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  return toLocalInputValue(d);
}

/** Placeholder do campo de texto conforme o modo do composer. */
export function placeholderFor(opts: {
  internal: boolean;
  blocked: boolean;
  group: boolean;
}): string {
  if (opts.internal) return "Escreva uma nota interna... Use @ para mencionar";
  if (opts.blocked) return "Janela fechada — aguarde o cliente escrever de novo";
  if (opts.group) return "Mensagem para o grupo... Use @ para mencionar um membro";
  return "Digite uma mensagem...";
}
