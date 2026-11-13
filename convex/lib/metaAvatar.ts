/**
 * Foto do contato do Instagram/Messenger — regras PURAS. A URL de `profile_pic`
 * vem do CDN da Meta e expira: é baixada na hora e o ARQUIVO é guardado no storage
 * (mesmo destino da foto do WhatsApp; ver lib/metaAvatarOps.ts).
 */

const META_CDN_SUFFIXES = [".fbcdn.net", ".cdninstagram.com", ".fbsbx.com"] as const;

/** `https:` sem credenciais e host dentro dos CDNs da Meta (senão recusa: sem SSRF). */
export function isAllowedMetaAvatarUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return META_CDN_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
  } catch {
    return false;
  }
}

/** `profile_pic` do corpo do perfil, ou `undefined` (ausente/vazio/não texto). */
export function profilePicOf(body: Record<string, unknown>): string | undefined {
  const pic = body.profile_pic;
  return typeof pic === "string" && pic.trim() ? pic.trim() : undefined;
}
