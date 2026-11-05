/** Densidade da lista "Requer atenção" — preferência pessoal, guardada no navegador. */
export type AttentionDensity = "compact" | "comfortable";

export const ATTENTION_DENSITY_KEY = "hnbcrm.attentionDensity";
export const DEFAULT_ATTENTION_DENSITY: AttentionDensity = "compact";

/** Parser tolerante: qualquer valor desconhecido (ou ausente) cai no padrão. */
export function parseAttentionDensity(raw: unknown): AttentionDensity {
  if (typeof raw !== "string") return DEFAULT_ATTENTION_DENSITY;
  const v = raw.trim().replace(/^"|"$/g, "").toLowerCase();
  return v === "comfortable" || v === "compact" ? v : DEFAULT_ATTENTION_DENSITY;
}

export function readAttentionDensity(): AttentionDensity {
  try {
    return parseAttentionDensity(localStorage.getItem(ATTENTION_DENSITY_KEY));
  } catch {
    return DEFAULT_ATTENTION_DENSITY;
  }
}

export function writeAttentionDensity(density: AttentionDensity): void {
  try {
    localStorage.setItem(ATTENTION_DENSITY_KEY, density);
  } catch {
    // Armazenamento indisponível: a escolha vale só nesta sessão.
  }
}
