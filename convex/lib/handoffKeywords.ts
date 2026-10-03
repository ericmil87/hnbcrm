/**
 * Palavra-chave de repasse (cliente pede atendimento humano).
 *
 * Casamento por palavra/expressão INTEIRA, normalizado sem acento/caixa nos
 * dois lados; pontuação/espaços múltiplos entre as palavras da frase são
 * tolerados. Palavra-chave CONFIGURADA pelo usuário casa como veio ("atendente"
 * casa em "o atendente foi ótimo" — ele escolheu o termo).
 *
 * Os padrões DEFAULT são frases de intenção; as palavras soltas "atendente" e
 * "humano" só valem em mensagem curta (≤ SHORT_MESSAGE_MAX_WORDS palavras),
 * para "o atendente foi ótimo" não abrir repasse.
 */

export const SHORT_MESSAGE_MAX_WORDS = 3;

export const DEFAULT_HANDOFF_KEYWORDS: readonly string[] = [
  "falar com atendente",
  "falar com um atendente",
  "quero um atendente",
  "atendente humano",
  "falar com humano",
  "falar com um humano",
  "falar com uma pessoa",
  "pessoa de verdade",
  "falar com alguém",
  "quero falar com alguém",
];

/** Palavras soltas dos padrões: só casam em mensagem curta. */
const SHORT_ONLY_DEFAULT_WORDS: readonly string[] = ["atendente", "humano"];

/**
 * minúsculas, sem acento (combinantes Unicode removidos após NFKD); tudo que
 * não é a-z/0-9 vira espaço. Atenção: letras não decomponíveis (ß, ø, æ…) não
 * viram ASCII e também são apagadas — irrelevante para PT-BR.
 */
export function normalizeHandoffText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function containsPhrase(haystack: string, keyword: string): boolean {
  const k = normalizeHandoffText(keyword ?? "");
  return k.length > 0 && haystack.includes(` ${k} `);
}

export function matchesHandoffKeyword(
  content: string | undefined | null,
  keywords: readonly string[] | undefined | null
): boolean {
  if (!content) return false;
  const normalized = normalizeHandoffText(content);
  // Espaços nas pontas formam a fronteira: " texto " contém " palavra ".
  const haystack = ` ${normalized} `;
  if (keywords && keywords.length > 0) {
    return keywords.some((k) => containsPhrase(haystack, k));
  }
  if (DEFAULT_HANDOFF_KEYWORDS.some((k) => containsPhrase(haystack, k))) return true;
  const wordCount = normalized === "" ? 0 : normalized.split(" ").length;
  return (
    wordCount > 0 &&
    wordCount <= SHORT_MESSAGE_MAX_WORDS &&
    SHORT_ONLY_DEFAULT_WORDS.some((k) => containsPhrase(haystack, k))
  );
}
