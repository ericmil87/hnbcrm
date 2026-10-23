/**
 * Adapter de host/endpoints da Graph API para Meta Messaging (puro, sem ctx).
 *
 * Isola a forma de conexão #1 (Facebook Login for Business, `graph.facebook.com`,
 * token de Página) da forma #2 (Instagram Login, `graph.instagram.com`, fora da
 * F0). NÃO reusa `GRAPH_API_BASE` do WhatsApp (outra versão, v23.0).
 *
 * O token NUNCA entra na URL aqui: quem chama manda `Authorization: Bearer`.
 */
import type { MetaSurface } from "./metaMessagingParse";

export const META_GRAPH_VERSION = "v26.0";

export type MetaAuthMethod = "facebook_login" | "instagram_login";

export function graphBase(auth: MetaAuthMethod): string {
  const host = auth === "instagram_login" ? "graph.instagram.com" : "graph.facebook.com";
  return `https://${host}/${META_GRAPH_VERSION}`;
}

type EndpointCtx = {
  authMethod: MetaAuthMethod;
  surface: MetaSurface;
  pageId?: string;
  igAccountId?: string;
};

/**
 * facebook_login (Messenger e IG): `/{page-id}/messages`; instagram_login:
 * `/{ig-id}/messages`. O envio em si é F1; aqui só o endereço.
 */
export function sendEndpoint(c: EndpointCtx): string {
  const base = graphBase(c.authMethod);
  const id = c.authMethod === "instagram_login" ? c.igAccountId : c.pageId;
  if (!id) throw new Error("sendEndpoint: conexão sem id de Página/conta");
  return `${base}/${encodeURIComponent(id)}/messages`;
}

/** Perfil do remetente. Campos por superfície (D3; §13 item 9 confirma ao vivo). */
export function profileEndpoint(c: EndpointCtx, userId: string, surface: MetaSurface): string {
  const fields =
    surface === "instagram" ? "name,username,profile_pic" : "first_name,last_name,profile_pic";
  return `${graphBase(c.authMethod)}/${encodeURIComponent(userId)}?fields=${fields}`;
}

/** Página: token não expira (nada a renovar). Forma #2 (ig_user, 60 dias) entra depois. */
export function needsRefresh(
  conn: { tokenKind: string; tokenExpiresAt?: number },
  now: number
): boolean {
  if (conn.tokenKind === "page") return false;
  if (conn.tokenExpiresAt === undefined) return false;
  return conn.tokenExpiresAt - now < 7 * 24 * 60 * 60 * 1000;
}
