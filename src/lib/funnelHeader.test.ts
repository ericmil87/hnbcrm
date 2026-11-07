import { describe, expect, it } from "vitest";
import { funnelHeaderPlan, type FunnelHeaderInput } from "./funnelHeader";

const SETTINGS = [
  { id: "edit", label: "Editar funil" },
  { id: "stages", label: "Gerenciar etapas" },
  { id: "archive", label: "Arquivar funil" },
  { id: "delete", label: "Excluir funil", danger: true },
];

const base: FunnelHeaderInput = {
  canCreateLead: true,
  view: "board",
  showArchivedLeads: false,
  hasSelectedBoard: true,
  boardSettings: SETTINGS,
  archivedBoardCount: 0,
};

const ids = (input: Partial<FunnelHeaderInput>) => funnelHeaderPlan({ ...base, ...input }).menuItems.map((i) => i.id);

describe("funnelHeaderPlan", () => {
  it("com permissão, o + é Criar lead", () => {
    const { actions } = funnelHeaderPlan(base);
    expect(actions).toEqual([{ id: "funnel-create-lead", label: "Criar lead", command: { kind: "createLead" } }]);
  });

  it("sem permissão, nenhuma ação", () => {
    expect(funnelHeaderPlan({ ...base, canCreateLead: false }).actions).toEqual([]);
  });

  it("ordem do ⋯ no quadro com funil selecionado", () => {
    expect(ids({})).toEqual([
      "funnel-archived-leads",
      "funnel-card-display",
      "funnel-board-edit",
      "funnel-board-stages",
      "funnel-board-archive",
      "funnel-board-delete",
    ]);
  });

  it("modo lista não tem Exibição dos cards", () => {
    expect(ids({ view: "list" })).not.toContain("funnel-card-display");
  });

  it("sem funil selecionado, nenhum item funnel-board-*", () => {
    expect(ids({ hasSelectedBoard: false }).some((id) => id.startsWith("funnel-board-"))).toBe(false);
  });

  it("rótulo dos leads arquivados acompanha o estado", () => {
    const label = (showArchivedLeads: boolean) => funnelHeaderPlan({ ...base, showArchivedLeads }).menuItems[0].label;
    expect(label(false)).toBe("Ver leads arquivados");
    expect(label(true)).toBe("Ver leads ativos");
  });

  it("excluir funil é perigoso e leva o id da configuração", () => {
    const del = funnelHeaderPlan(base).menuItems.find((i) => i.id === "funnel-board-delete");
    expect(del?.danger).toBe(true);
    expect(del?.command).toEqual({ kind: "boardSetting", settingId: "delete" });
  });

  describe("separador do grupo do funil", () => {
    it("fica no primeiro item de configuração; Funis arquivados vem depois sem separador", () => {
      const items = funnelHeaderPlan({ ...base, archivedBoardCount: 2 }).menuItems;
      expect(items.filter((i) => i.separatorBefore).map((i) => i.id)).toEqual(["funnel-board-edit"]);
      const archived = items[items.length - 1];
      expect(archived).toMatchObject({ id: "funnel-archived-boards", label: "Funis arquivados (2)" });
      expect(archived.separatorBefore).toBeUndefined();
    });

    it("sem funil selecionado, Funis arquivados abre o grupo com separador", () => {
      const items = funnelHeaderPlan({ ...base, hasSelectedBoard: false, archivedBoardCount: 1 }).menuItems;
      expect(items.map((i) => i.id)).toEqual(["funnel-archived-leads", "funnel-card-display", "funnel-archived-boards"]);
      expect(items[2].separatorBefore).toBe(true);
    });

    it("sem funis arquivados, não há o item", () => {
      expect(ids({})).not.toContain("funnel-archived-boards");
    });
  });
});
