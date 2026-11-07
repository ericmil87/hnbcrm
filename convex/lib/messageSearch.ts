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

/** Teto do campo dobrado em unidades UTF-16 (o índice só precisa do começo de textos longos). */
export const MESSAGE_SEARCH_MAX_CHARS = 4000;

/**
 * Corta em `max` unidades UTF-16 sem partir um par substituto (emoji): um
 * high surrogate solto no fim é UTF-16 inválido e o backend recusa a string.
 */
export function cutUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = text.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

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
  // Pré-corte antes da dobra (texto enorme não é dobrado inteiro); o corte
  // final é o que vale. Os dois respeitam pares substitutos.
  const folded = cutUtf16(
    foldForSearch(cutUtf16(joined, MESSAGE_SEARCH_MAX_CHARS * 2)),
    MESSAGE_SEARCH_MAX_CHARS
  ).trim();
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
