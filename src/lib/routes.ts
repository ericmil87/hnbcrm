import { NAV_ITEMS } from "./nav";

export type Tab =
  | "dashboard"
  | "board"
  | "contacts"
  | "inbox"
  | "tasks"
  | "calendar"
  | "handoffs"
  | "team"
  | "audit"
  | "settings"
  | "forms"
  | "campaigns"
  | "groups"
  | "central";

export const TAB_ROUTES: Record<Tab, string> = {
  dashboard: "/app/painel",
  board: "/app/pipeline",
  contacts: "/app/contatos",
  inbox: "/app/entrada",
  tasks: "/app/tarefas",
  calendar: "/app/calendario",
  handoffs: "/app/repasses",
  team: "/app/equipe",
  audit: "/app/auditoria",
  forms: "/app/formularios",
  campaigns: "/app/campanhas",
  groups: "/app/grupos",
  central: "/app/central",
  settings: "/app/configuracoes",
};

/** Configuração inicial (assistente v2). Fora do menu: abre por URL, pelo Painel e por Configurações. */
export const ONBOARDING_ROUTE = "/app/configuracao-inicial";

/**
 * Aba ativa de um caminho, pelo prefixo mais longo: sub-rotas como
 * `/app/formularios/:formId/submissoes` ativam a aba da raiz (`forms`).
 * Lê `matchPrefixes` extras de `NAV_ITEMS`. Caminho fora das abas devolve `undefined`.
 */
export function activeTabForPath(pathname: string): Tab | undefined {
  let best: Tab | undefined;
  let bestLength = -1;
  for (const [tab, root] of Object.entries(TAB_ROUTES) as [Tab, string][]) {
    const extra = NAV_ITEMS.find((i) => i.id === tab)?.matchPrefixes ?? [];
    for (const prefix of [root, ...extra]) {
      const matches = pathname === prefix || pathname.startsWith(prefix + "/");
      if (matches && prefix.length > bestLength) {
        best = tab;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}
