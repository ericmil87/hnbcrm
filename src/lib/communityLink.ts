/**
 * Link do grupo da comunidade (S8 e navegação da landing). Vem de
 * `import.meta.env.VITE_COMMUNITY_URL`; sem a env, ou com um valor que não é
 * `https://`, a seção e o link não aparecem.
 */
export function parseCommunityUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Link configurado no build, ou `null`. */
export function communityUrl(): string | null {
  return parseCommunityUrl(import.meta.env.VITE_COMMUNITY_URL);
}
