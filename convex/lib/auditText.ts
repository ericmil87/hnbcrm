/**
 * Texto longo dentro de `auditLogs.changes` (persona/knowledge de agente).
 * Guardamos o TEXTO — é o que permite reverter uma edição de ops — mas com teto,
 * porque o audit log é lido em lista. Passou do teto: guarda o começo + um
 * marcador com tamanho e SHA-256 do texto COMPLETO (dá para provar qual versão
 * era, e o dump que gerou a edição continua sendo a fonte do texto inteiro).
 * O hash usa `crypto.subtle` (disponível no runtime padrão do Convex, inclusive
 * em mutation, e no ambiente de teste).
 */
export const AUDIT_TEXT_MAX_CHARS = 50_000;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function auditTextSnapshot(
  text: string,
  maxChars: number = AUDIT_TEXT_MAX_CHARS
): Promise<string> {
  if (text.length <= maxChars) return text;
  const hash = await sha256Hex(text);
  return `${text.slice(0, maxChars)}…[truncado: ${text.length} chars, sha256 ${hash}]`;
}
