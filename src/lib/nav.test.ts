import { describe, expect, it } from "vitest";
import { NAV_GROUPS, NAV_ITEMS, badgeA11yText, formatBadgeCount, groupNavItems, shellPageTitle, moreSheetSections, splitMobile, visibleNavItems } from "./nav";
import { TAB_ROUTES, activeTabForPath } from "./routes";
import { VOCAB, vocabLabels } from "./vocab";

describe("NAV_ITEMS", () => {
  it("cada Tab de TAB_ROUTES aparece exatamente uma vez", () => {
    const ids = NAV_ITEMS.map((i) => i.id).sort();
    expect(ids).toEqual(Object.keys(TAB_ROUTES).sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("tem os 14 itens na ordem do plano", () => {
    expect(NAV_ITEMS.map((i) => i.id)).toEqual([
      "dashboard", "inbox", "handoffs", "board", "contacts", "tasks", "calendar",
      "campaigns", "groups", "forms", "central", "team", "audit", "settings",
    ]);
  });

  it("todo rótulo vem de VOCAB", () => {
    const labels = new Set(vocabLabels());
    for (const item of NAV_ITEMS) expect(labels.has(item.label), item.label).toBe(true);
  });

  it("todo item tem title vindo de VOCAB, igual ao título que a página usa", () => {
    const labels = new Set(vocabLabels());
    for (const item of NAV_ITEMS) {
      expect(item.title, item.id).toBeTruthy();
      expect(labels.has(item.title), item.title).toBe(true);
    }
    const byId = Object.fromEntries(NAV_ITEMS.map((i) => [i.id, i.title]));
    expect(byId.board).toBe(VOCAB.funnel.title);
    expect(byId.inbox).toBe(VOCAB.conversations.title);
    expect(byId.contacts).toBe(VOCAB.contact.nav);
  });

  it("todo grupo usado existe em NAV_GROUPS", () => {
    const ids = new Set<string>(NAV_GROUPS.map((g) => g.id));
    for (const item of NAV_ITEMS) expect(ids.has(item.group ?? "topo")).toBe(true);
  });
});

describe("visibleNavItems", () => {
  it("filtra por permissão", () => {
    const items = visibleNavItems((c) => c === "contacts", { central: true });
    expect(items.map((i) => i.id)).toEqual(["dashboard", "contacts"]);
  });

  it("Relatórios exige o módulo central", () => {
    const can = () => true;
    expect(visibleNavItems(can, {}).some((i) => i.id === "central")).toBe(false);
    expect(visibleNavItems(can, { central: true }).some((i) => i.id === "central")).toBe(true);
  });

  it("Formulários exige settings:manage e Configurações settings:view", () => {
    const can = (c: string, l: string) => c === "settings" && l === "view";
    const ids = visibleNavItems(can, {}).map((i) => i.id);
    expect(ids).toContain("settings");
    expect(ids).not.toContain("forms");
  });
});

describe("splitMobile", () => {
  it("devolve no máximo 4 primários, na ordem do plano", () => {
    const { primary, more } = splitMobile(visibleNavItems(() => true, { central: true }));
    expect(primary.map((i) => i.id)).toEqual(["dashboard", "inbox", "handoffs", "board"]);
    expect(primary.length).toBeLessThanOrEqual(4);
    expect(more.map((i) => i.id).slice(0, 3)).toEqual(["contacts", "tasks", "calendar"]);
    expect(primary.length + more.length).toBe(14);
  });

  it("item primário sem permissão não puxa outro para a barra", () => {
    const { primary } = splitMobile(visibleNavItems((c) => c !== "inbox", {}));
    expect(primary.map((i) => i.id)).toEqual(["dashboard", "board"]);
  });
});

describe("groupNavItems", () => {
  it("agrupa e omite grupos vazios", () => {
    const groups = groupNavItems(visibleNavItems((c) => c === "contacts", {}));
    expect(groups.map((g) => g.id)).toEqual(["topo", "atendimento"]);
  });
});

describe("activeTabForPath", () => {
  it("sub-rotas de formulários ativam forms", () => {
    expect(activeTabForPath("/app/formularios/x/submissoes")).toBe("forms");
    expect(activeTabForPath("/app/formularios/x")).toBe("forms");
    expect(activeTabForPath("/app/formularios")).toBe("forms");
  });
  it("caminho desconhecido não ativa nada", () => {
    expect(activeTabForPath("/app/nada")).toBeUndefined();
    expect(activeTabForPath("/app/painelx")).toBeUndefined();
  });
});

describe("badges", () => {
  it("formata e descreve", () => {
    expect(formatBadgeCount(0)).toBeNull();
    expect(formatBadgeCount(120)).toBe("99+");
    expect(badgeA11yText("inboxUnread", 3)).toBe("3 não lidas");
    expect(badgeA11yText("inboxUnread", 1)).toBe("1 não lida");
    expect(badgeA11yText("pendingAttention", 2)).toBe("2 pedidos de ajuda");
    expect(badgeA11yText("pausedCampaigns", 1)).toBe("1 pausada");
    expect(badgeA11yText("inboxUnread", 0)).toBeNull();
  });
});

describe("moreSheetSections", () => {
  it("Contatos, Tarefas e Agenda ficam na primeira seção, nesta ordem", () => {
    const { more } = splitMobile(visibleNavItems(() => true, { central: true }));
    const sections = moreSheetSections(more);
    expect(sections[0].items.map((i) => i.id).slice(0, 3)).toEqual(["contacts", "tasks", "calendar"]);
    expect(sections.map((s) => s.id)).toEqual(["atendimento-organizacao", "divulgacao", "gestao"]);
  });

  it("sem Organização não funde nada", () => {
    const { more } = splitMobile(visibleNavItems((c) => c === "contacts", {}));
    expect(moreSheetSections(more).map((s) => s.id)).toEqual(["atendimento"]);
  });
});

describe("shellPageTitle", () => {
  it("Configurações define o próprio título", () => {
    expect(shellPageTitle("/app/configuracoes")).toBeNull();
  });
  it("rota com item usa o título do item", () => {
    expect(shellPageTitle("/app/entrada")).toBe(VOCAB.inbox.title);
  });
  it("rota desconhecida cai no nome do app", () => {
    expect(shellPageTitle("/app/nao-existe")).toBe("HNBCRM");
  });
});
