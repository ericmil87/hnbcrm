/**
 * Chaves do record `mapping`/`suggestedMapping` de importJobs.
 *
 * Módulo PURO (sem deps Convex) — importável tanto pelo backend
 * (convex/imports.ts, convex/importRun.ts) quanto pelo frontend (wizard de
 * importação) e pelas rotas REST, para que todos codifiquem o cabeçalho da
 * MESMA forma.
 *
 * O Convex só aceita ASCII em NOME DE CAMPO ("Field names can only contain
 * non-control ASCII characters"), e cabeçalho PT-BR tem acento ("Título",
 * "Estágio"). Por isso a chave do record é `encodeURIComponent(header)` — o
 * cabeçalho original continua legível em `detectedHeaders` (array de valores).
 */
export function encodeHeaderKey(header: string): string {
  return encodeURIComponent(header);
}

/**
 * Cabeçalhos que não podem virar chave de record nem depois de codificados.
 * (`encodeURIComponent` não escapa `_`/`$` iniciais, reservados pelo Convex.)
 */
export function invalidHeader(header: string): string | null {
  if (header.startsWith("_") || header.startsWith("$")) {
    return `A coluna "${header}" começa com "_" ou "$" — renomeie o cabeçalho no arquivo.`;
  }
  if (encodeHeaderKey(header).length > 64) {
    return `A coluna "${header.slice(0, 24)}…" tem um cabeçalho longo demais — encurte para até 64 caracteres.`;
  }
  return null;
}

/** Converte `chave codificada → campo` em `cabeçalho cru → campo`. */
export function mappingForHeaders(
  headers: string[],
  mapping: Record<string, string> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of headers) {
    const destination = mapping?.[encodeHeaderKey(header)];
    if (destination) out[header] = destination;
  }
  return out;
}
