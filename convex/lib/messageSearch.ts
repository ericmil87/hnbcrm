/**
 * Campo de busca sem acento das mensagens (`messages.searchNorm`, índice
 * `search_norm`). É a dobra (`foldForSearch`) de conteúdo + transcrição da
 * nota de voz + leitura da imagem, limitada a `MESSAGE_SEARCH_MAX_CHARS`.
 *
 * Porta única: TODO `insert("messages")` passa o documento por
 * `withMessageSearch`, e todo patch que muda `content`, `transcriptText` ou
 * `imageDescription` passa por `withMessageSearchPatch`. Guard de build:
 * `convex/messageSearchPort.test.ts`.
 */
import type { Doc } from "../_generated/dataModel";
import type { WithoutSystemFields } from "convex/server";
import { foldForSearch } from "./searchFold";

/** Teto do campo dobrado (o índice só precisa do começo de textos longos). */
export const MESSAGE_SEARCH_MAX_CHARS = 8000;

type SearchSource = {
  content?: string;
  transcriptText?: string;
  imageDescription?: string;
};

/** O texto dobrado da mensagem, ou `undefined` quando não há texto. */
export function messageSearchNorm(m: SearchSource): string | undefined {
  const joined = [m.content, m.transcriptText, m.imageDescription]
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter(Boolean)
    .join(" ");
  if (!joined) return undefined;
  const folded = foldForSearch(joined).slice(0, MESSAGE_SEARCH_MAX_CHARS).trim();
  return folded || undefined;
}

type MessageInsert = WithoutSystemFields<Doc<"messages">>;

/** Documento de insert de mensagem com `searchNorm` calculado. */
export function withMessageSearch(doc: MessageInsert): MessageInsert {
  const searchNorm = messageSearchNorm(doc);
  const out: MessageInsert = { ...doc };
  if (searchNorm) out.searchNorm = searchNorm;
  else delete out.searchNorm;
  return out;
}

/**
 * Patch de mensagem com `searchNorm` recalculado sobre o estado final
 * (`current` + `patch`). Chave presente com `undefined` no patch apaga o campo
 * (ex.: `imageDescription: undefined` numa releitura que falhou).
 */
export function withMessageSearchPatch<P extends Partial<MessageInsert>>(
  current: SearchSource,
  patch: P
): P & { searchNorm: string | undefined } {
  const merged: SearchSource = {
    content: "content" in patch ? patch.content : current.content,
    transcriptText: "transcriptText" in patch ? patch.transcriptText : current.transcriptText,
    imageDescription: "imageDescription" in patch ? patch.imageDescription : current.imageDescription,
  };
  return { ...patch, searchNorm: messageSearchNorm(merged) };
}
