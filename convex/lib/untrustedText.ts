/**
 * Limpeza de texto de TERCEIROS (site, PDF) antes de qualquer LLM — puro.
 *
 * Esconderijos de injeção que sobrevivem à extração como "texto normal"
 * (pesquisa 05, seção E): caracteres de largura zero, overrides bidi, bloco de
 * tags Unicode U+E0000–E007F (texto ASCII invisível), controles C0/C1, hífen
 * suave, preenchedores Hangul. NFKC antes de tudo (letras de largura cheia e
 * compatibilidade viram a forma comum). O texto limpo continua sendo DADO.
 */

// Invisíveis/formatação: controles (menos \t \n), C1, soft hyphen, CGJ,
// Hangul fillers, Mongolian vowel sep, ZW*, LRM/RLM, separadores de linha/
// parágrafo (tratados à parte), bidi embeddings/overrides/isolates, word
// joiner e invisíveis matemáticos, BOM, anotações interlineares.
const INVISIBLE_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB]|\uDB40[\uDC00-\uDC7F]/g;

const TAG_CHAR_RE = /\uDB40[\uDC00-\uDC7F]/g;

export type CleanTextStats = {
  invisibleChars: number;
  tagChars: number;
};

/** NFKC + remove invisíveis + normaliza espaços/linhas. */
export function cleanUntrustedText(input: string): { text: string; stats: CleanTextStats } {
  const nfkc = input.normalize("NFKC");
  const tagChars = (nfkc.match(TAG_CHAR_RE) ?? []).length;
  let invisibleChars = 0;
  const stripped = nfkc.replace(INVISIBLE_RE, () => {
    invisibleChars++;
    return "";
  });
  const text = stripped
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n")
    .replace(/[\t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000 ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, stats: { invisibleChars: invisibleChars - tagChars, tagChars } };
}

/** Corta no limite sem partir um par substituto; `truncated` diz se cortou. */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  let end = maxChars;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return { text: text.slice(0, end), truncated: true };
}
