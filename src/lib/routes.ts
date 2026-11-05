import type { Tab } from "@/components/layout/BottomTabBar";

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

/**
 * Aba ativa de um caminho, pelo prefixo mais longo: sub-rotas como
 * `/app/formularios/:formId/submissoes` ativam a aba da raiz (`forms`).
 * Caminho fora das abas devolve `undefined`.
 */
export function activeTabForPath(pathname: string): Tab | undefined {
  let best: Tab | undefined;
  let bestLength = -1;
  for (const [tab, root] of Object.entries(TAB_ROUTES) as [Tab, string][]) {
    const matches = pathname === root || pathname.startsWith(root + "/");
    if (matches && root.length > bestLength) {
      best = tab;
      bestLength = root.length;
    }
  }
  return best;
}
