import { TAB_ROUTES } from "./routes";

/** Rota de entrada de links entre organizações (sino, push do F1): `/app/abrir?org=&to=`. */
export const OPEN_ROUTE = "/app/abrir";

/**
 * `to` só vale se for caminho interno do app: começa com `/app/`, sem `//`,
 * barra invertida, esquema ou caracteres de controle (open redirect), e não
 * aponta para a própria rota de abertura (laço).
 */
export function isSafeAppPath(to: string | null | undefined): to is string {
  if (!to || typeof to !== "string") return false;
  if (!to.startsWith("/app/")) return false;
  if (to.startsWith("//") || to.includes("\\") || to.includes("://")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(to)) return false;
  if (/^\/app\/+abrir(\/|\?|#|$)/.test(to)) return false;
  try {
    const u = new URL(to, "https://app.invalid");
    if (u.origin !== "https://app.invalid" || !u.pathname.startsWith("/app/")) return false;
  } catch {
    return false;
  }
  return true;
}

export function parseOpenLink(search: string): { org: string; to: string } | null {
  const params = new URLSearchParams(search);
  const org = params.get("org");
  const to = params.get("to");
  if (!org || !isSafeAppPath(to)) return null;
  return { org, to };
}

export function buildOpenLink(org: string, to: string): string {
  return `${OPEN_ROUTE}?${new URLSearchParams({ org, to }).toString()}`;
}

/** Destino quando só se sabe a org: o Painel com o sino aberto. */
export const ORG_NEWS_TARGET = `${TAB_ROUTES.dashboard}?sino=1`;
