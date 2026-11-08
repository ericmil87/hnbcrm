import { TAB_ROUTES } from "./routes";

/** Rota de entrada de links entre organizações (sino, push do F1): `/app/abrir?org=&to=`. */
export const OPEN_ROUTE = "/app/abrir";

/**
 * Destino seguro e normalizado (`pathname + search + hash` do URL resolvido),
 * ou `null`. Só vale caminho interno do app: `/app/…` sem `//` no início,
 * barra invertida, esquema ou caracteres de controle (open redirect). A regra
 * "não aponta para a própria rota" olha o caminho já normalizado (`/app/./abrir`,
 * `/app//abrir`, `%2e`) e ignora maiúsculas (o roteador também ignora).
 */
export function safeAppTarget(to: string | null | undefined): string | null {
  if (!to || typeof to !== "string") return null;
  if (!to.startsWith("/app/")) return null;
  if (to.startsWith("//") || to.includes("\\") || to.includes("://")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(to)) return null;
  let u: URL;
  try {
    u = new URL(to, "https://app.invalid");
  } catch {
    return null;
  }
  if (u.origin !== "https://app.invalid" || !u.pathname.startsWith("/app/")) return null;
  const collapsed = u.pathname.replace(/\/{2,}/g, "/").toLowerCase();
  if (/^\/app\/abrir(\/|$)/.test(collapsed)) return null;
  return u.pathname + u.search + u.hash;
}

export function isSafeAppPath(to: string | null | undefined): to is string {
  return safeAppTarget(to) !== null;
}

export function parseOpenLink(search: string): { org: string; to: string } | null {
  const params = new URLSearchParams(search);
  const org = params.get("org");
  const to = safeAppTarget(params.get("to"));
  if (!org || !to) return null;
  return { org, to };
}

export function buildOpenLink(org: string, to: string): string {
  return `${OPEN_ROUTE}?${new URLSearchParams({ org, to }).toString()}`;
}

/** Destino quando só se sabe a org: o Painel com o sino aberto. */
export const ORG_NEWS_TARGET = `${TAB_ROUTES.dashboard}?sino=1`;
