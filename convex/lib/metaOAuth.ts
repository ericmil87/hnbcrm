/**
 * Facebook Login for Business (Meta Messaging) — peças PURAS do OAuth: URL do
 * diálogo, escopos exigidos, escolha de Páginas e códigos de erro da URL de
 * retorno. Sem rede, sem ctx. A orquestração mora em `convex/metaMessaging.ts`.
 */
import { META_GRAPH_VERSION } from "./metaGraph";

/** As 8 permissões pedidas no `config_id` (D1, ajuste 2). Todas ou nenhuma. */
export const REQUIRED_SCOPES = [
  "public_profile",
  "business_management",
  "pages_show_list",
  "pages_manage_metadata",
  "pages_messaging",
  "pages_read_engagement",
  "instagram_basic",
  "instagram_manage_messages",
] as const;

export function missingScopes(granted: readonly string[]): string[] {
  const set = new Set(granted);
  return REQUIRED_SCOPES.filter((s) => !set.has(s));
}

/** Diálogo do FLfB: `config_id` no lugar de `scope` (a doc desaconselha os dois). */
export function buildAuthorizeUrl(args: {
  appId: string;
  redirectUri: string;
  configId: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: args.appId,
    redirect_uri: args.redirectUri,
    config_id: args.configId,
    response_type: "code",
    state: args.state,
  });
  return `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

export type MetaAccountRaw = {
  id?: unknown;
  name?: unknown;
  access_token?: unknown;
  tasks?: unknown;
  instagram_business_account?: { id?: unknown; username?: unknown; name?: unknown } | null;
};

export type UsablePage = {
  pageId: string;
  pageName: string;
  /** Token de Página em claro: só vive em memória até virar `encryptSecret`. */
  pageToken: string;
  igAccountId?: string;
  igUsername?: string;
  tasksOk: boolean;
};

/**
 * `GET /me/accounts` → Páginas com token. `tasksOk` = `tasks` contém MESSAGING
 * e MODERATE. Página sem id/nome/token é descartada.
 */
export function pickUsablePages(accounts: unknown): UsablePage[] {
  if (!Array.isArray(accounts)) return [];
  const out: UsablePage[] = [];
  for (const raw of accounts as MetaAccountRaw[]) {
    if (!raw || typeof raw !== "object") continue;
    const pageId = typeof raw.id === "string" ? raw.id : undefined;
    const pageToken = typeof raw.access_token === "string" ? raw.access_token : undefined;
    if (!pageId || !pageToken) continue;
    const pageName = typeof raw.name === "string" && raw.name ? raw.name : `Página ${pageId.slice(-4)}`;
    // §13 item 7: `tasks` pode não vir; sem o campo assumimos utilizável (o envio acusa se não for).
    const tasksOk = Array.isArray(raw.tasks)
      ? raw.tasks.includes("MESSAGING") && raw.tasks.includes("MODERATE")
      : true;
    const ig = raw.instagram_business_account;
    const igAccountId = ig && typeof ig.id === "string" ? ig.id : undefined;
    const igUsername = ig && typeof ig.username === "string" ? ig.username : undefined;
    out.push({
      pageId,
      pageName,
      pageToken,
      tasksOk,
      ...(igAccountId ? { igAccountId } : {}),
      ...(igUsername ? { igUsername } : {}),
    });
  }
  return out;
}

export const META_OAUTH_ERROR_CODES = [
  "cancelado",
  "expirado",
  "conta_em_uso",
  "sem_permissao",
  "sem_pagina",
  "sem_papel",
  "modulo_off",
  "falha_meta",
] as const;
export type MetaOAuthErrorCode = (typeof META_OAUTH_ERROR_CODES)[number];

/** Redirect de volta ao app. Nunca carrega token, corpo da Meta, PSID ou nome. */
export function redirectUrlFor(
  appUrl: string,
  result:
    | MetaOAuthErrorCode
    | "ok"
    | { selecionar: true; pendenteId: string }
    | { finalizar: true; state: string }
): string {
  const base = `${appUrl.replace(/\/+$/, "")}/app/configuracoes?secao=channels`;
  if (typeof result === "string") return `${base}&meta=${result}`;
  if ("finalizar" in result) return `${base}&meta=finalizar&state=${encodeURIComponent(result.state)}`;
  return `${base}&meta=selecionar&pendente=${encodeURIComponent(result.pendenteId)}`;
}
