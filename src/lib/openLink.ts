import { TAB_ROUTES } from "./routes";
import { safeAppTarget } from "./push/notificationClick";

/** Rota de entrada de links entre organizações (sino, push do F1): `/app/abrir?org=&to=`. */
export const OPEN_ROUTE = "/app/abrir";

// Validador único: mora em push/notificationClick.ts (puro, sem imports, também entra no service worker).
export { safeAppTarget };

/** Ação pedida por um botão do push (`&acao=assumir`): a tela do destino confirma antes de agir. */
export type OpenLinkAction = "assumir";

export function parseOpenLink(search: string): { org: string; to: string; acao?: OpenLinkAction } | null {
  const params = new URLSearchParams(search);
  const org = params.get("org");
  const to = safeAppTarget(params.get("to"));
  if (!org || !to) return null;
  return params.get("acao") === "assumir" ? { org, to, acao: "assumir" } : { org, to };
}

/** `to` + `acao=` na query do destino (a tela de destino lê `?acao=`). */
export function withOpenAction(to: string, acao: OpenLinkAction | undefined): string {
  if (!acao) return to;
  const u = new URL(to, "https://app.invalid");
  u.searchParams.set("acao", acao);
  return u.pathname + u.search + u.hash;
}

export function buildOpenLink(org: string, to: string): string {
  return `${OPEN_ROUTE}?${new URLSearchParams({ org, to }).toString()}`;
}

/** Destino quando só se sabe a org: o Painel com o sino aberto. */
export const ORG_NEWS_TARGET = `${TAB_ROUTES.dashboard}?sino=1`;
