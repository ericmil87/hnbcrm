// Contribuição do Funil ao cabeçalho do AppShell no celular (+ e ⋯), sem React:
// o `FunnelToolbar` só troca cada `command` por ícone e handler.

import type { FunnelView } from "./funnelFilters";

export type FunnelHeaderCommand =
  | { kind: "createLead" }
  | { kind: "toggleArchivedLeads" }
  | { kind: "cardDisplay" }
  | { kind: "boardSetting"; settingId: string }
  | { kind: "archivedBoards" };

export interface FunnelHeaderEntry {
  id: string;
  label: string;
  danger?: boolean;
  separatorBefore?: boolean;
  command: FunnelHeaderCommand;
}

export interface FunnelHeaderInput {
  canCreateLead: boolean;
  view: FunnelView;
  showArchivedLeads: boolean;
  hasSelectedBoard: boolean;
  /** Itens de "Configurações do funil" (os mesmos do desktop), na ordem. */
  boardSettings: readonly { id: string; label: string; danger?: boolean }[];
  archivedBoardCount: number;
}

export interface FunnelHeaderPlan {
  actions: FunnelHeaderEntry[];
  menuItems: FunnelHeaderEntry[];
}

/**
 * + "Criar lead" (com permissão) e o ⋯: leads arquivados, "Exibição dos cards"
 * (só no quadro), configurações do funil selecionado e "Funis arquivados (N)".
 * O grupo do funil (configurações + arquivados) começa com separador.
 */
export function funnelHeaderPlan(input: FunnelHeaderInput): FunnelHeaderPlan {
  const actions: FunnelHeaderEntry[] = input.canCreateLead
    ? [{ id: "funnel-create-lead", label: "Criar lead", command: { kind: "createLead" } }]
    : [];

  const menuItems: FunnelHeaderEntry[] = [
    {
      id: "funnel-archived-leads",
      label: input.showArchivedLeads ? "Ver leads ativos" : "Ver leads arquivados",
      command: { kind: "toggleArchivedLeads" },
    },
  ];
  if (input.view === "board") {
    menuItems.push({ id: "funnel-card-display", label: "Exibição dos cards", command: { kind: "cardDisplay" } });
  }

  const boardGroup: FunnelHeaderEntry[] = [];
  if (input.hasSelectedBoard) {
    for (const s of input.boardSettings) {
      boardGroup.push({
        id: `funnel-board-${s.id}`,
        label: s.label,
        ...(s.danger ? { danger: true } : {}),
        command: { kind: "boardSetting", settingId: s.id },
      });
    }
  }
  if (input.archivedBoardCount > 0) {
    boardGroup.push({
      id: "funnel-archived-boards",
      label: `Funis arquivados (${input.archivedBoardCount})`,
      command: { kind: "archivedBoards" },
    });
  }
  if (boardGroup.length > 0) boardGroup[0] = { ...boardGroup[0], separatorBefore: true };

  return { actions, menuItems: [...menuItems, ...boardGroup] };
}
