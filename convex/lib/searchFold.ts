/**
 * Dobra de texto para busca: minúsculas e sem acento ("Rebouças" → "reboucas",
 * "AÇÃO" → "acao"). O índice de busca do Convex (Tantivy SimpleTokenizer) já
 * ignora maiúsculas, mas NÃO ignora acentos: por isso o texto indexado e o
 * termo buscado passam pelos dois lados por esta mesma função.
 *
 * Fonte única para backend (escrita do índice, consulta, ranking) e frontend
 * (destaque do termo no trecho). Pura, sem dependências.
 */

/** Marcas combinantes (acentos) que sobram depois do NFD: U+0300–U+036F. */
const COMBINING_MARKS = /[̀-ͯ]/g;

/** Minúsculas + NFD + remove acentos. `ç` vira `c` (o NFD separa a cedilha). */
export function foldForSearch(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(COMBINING_MARKS, "");
}

/**
 * Texto dobrado + mapa de volta: `map[i]` é o índice, no texto ORIGINAL, do
 * caractere que gerou o caractere `i` do texto dobrado. Serve para achar o
 * termo sem acento e destacar o trecho com o acento original.
 */
export function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let i = 0;
  for (const ch of text) {
    const piece = foldForSearch(ch);
    for (let k = 0; k < piece.length; k++) map.push(i);
    folded += piece;
    i += ch.length;
  }
  return { folded, map };
}

/**
 * Primeira ocorrência de `term` em `text` ignorando maiúsculas e acentos.
 * Devolve o intervalo `[start, end)` no texto ORIGINAL (inclui acentos
 * combinantes soltos colados à última letra), ou `null`.
 */
export function findFolded(text: string, term: string): { start: number; end: number } | null {
  const needle = foldForSearch(term.trim());
  if (!needle) return null;
  const { folded, map } = foldWithMap(text);
  const idx = folded.indexOf(needle);
  if (idx === -1) return null;
  const endFolded = idx + needle.length;
  const start = map[idx];
  const end = endFolded < map.length ? map[endFolded] : text.length;
  return { start, end };
}
