import { describe, expect, it } from "vitest";
import {
  DEFAULT_FUNNEL_FILTERS,
  activeFilterCount,
  defaultSortOrder,
  filterLeads,
  getPriorityLabel,
  getPriorityVariant,
  getTemperatureLabel,
  getTemperatureVariant,
  lastBoardStorageKey,
  parseFunnelFilters,
  pickInitialBoardId,
  sortLeads,
  writeFunnelFilters,
} from "./funnelFilters";

interface TestLead {
  title: string;
  priority: string;
  temperature: string;
  assignee: { _id: string } | null;
  unitId?: string;
}

const lead = (over: Partial<TestLead> = {}): TestLead => ({
  title: "Contrato Acme",
  priority: "medium",
  temperature: "cold",
  assignee: null,
  unitId: undefined,
  ...over,
});

describe("labels e variantes", () => {
  it("traduz prioridade e temperatura e cai no valor cru se desconhecido", () => {
    expect(getPriorityLabel("urgent")).toBe("Urgente");
    expect(getPriorityLabel("xyz")).toBe("xyz");
    expect(getTemperatureLabel("hot")).toBe("Quente");
    expect(getTemperatureLabel("nope")).toBe("nope");
  });

  it("mapeia variantes de badge", () => {
    expect(getPriorityVariant("urgent")).toBe("error");
    expect(getPriorityVariant("high")).toBe("warning");
    expect(getPriorityVariant("low")).toBe("default");
    expect(getTemperatureVariant("hot")).toBe("error");
    expect(getTemperatureVariant("warm")).toBe("warning");
    expect(getTemperatureVariant("cold")).toBe("info");
  });
});

describe("parseFunnelFilters", () => {
  it("sem parâmetros usa os padrões", () => {
    expect(parseFunnelFilters("")).toEqual(DEFAULT_FUNNEL_FILTERS);
  });

  it("lê modo, busca e filtros", () => {
    expect(parseFunnelFilters("?view=list&q=acme&owner=m1&temp=hot&priority=urgent&unit=none")).toEqual({
      view: "list",
      q: "acme",
      owner: "m1",
      temp: "hot",
      priority: "urgent",
      unit: "none",
    });
  });

  it("valores inválidos caem no padrão", () => {
    const f = parseFunnelFilters("?view=kanban&temp=tepid&priority=huge&owner=");
    expect(f.view).toBe("board");
    expect(f.temp).toBe("all");
    expect(f.priority).toBe("all");
    expect(f.owner).toBe("all");
  });
});

describe("writeFunnelFilters", () => {
  it("grava valores e preserva os outros parâmetros", () => {
    const next = writeFunnelFilters(new URLSearchParams("board=b1&lead=l1"), { view: "list", q: "x" });
    expect(next.get("board")).toBe("b1");
    expect(next.get("lead")).toBe("l1");
    expect(next.get("view")).toBe("list");
    expect(next.get("q")).toBe("x");
  });

  it("valor padrão remove o parâmetro", () => {
    const next = writeFunnelFilters(new URLSearchParams("view=list&q=x&temp=hot"), {
      view: "board",
      q: "",
      temp: "all",
    });
    expect(next.toString()).toBe("");
  });

  it("não toca no que não veio em changes", () => {
    const next = writeFunnelFilters(new URLSearchParams("temp=hot&unit=u1"), { q: "a" });
    expect(next.get("temp")).toBe("hot");
    expect(next.get("unit")).toBe("u1");
  });
});

describe("activeFilterCount", () => {
  it("não conta o modo", () => {
    expect(activeFilterCount({ ...DEFAULT_FUNNEL_FILTERS, view: "list" })).toBe(0);
    expect(activeFilterCount({ ...DEFAULT_FUNNEL_FILTERS, q: "a", temp: "hot", unit: "none" })).toBe(3);
  });
});

describe("filterLeads", () => {
  const leads = [
    lead({ title: "Contrato Acme", priority: "urgent", temperature: "hot", assignee: { _id: "m1" } }),
    lead({ title: "Proposta Beta", priority: "low", temperature: "cold", unitId: "u1" }),
    lead({ title: "acme renovação", priority: "high", temperature: "warm", assignee: { _id: "m2" }, unitId: "u2" }),
  ];

  it("lista indefinida vira vazia", () => {
    expect(filterLeads(undefined, DEFAULT_FUNNEL_FILTERS, true)).toEqual([]);
  });

  it("busca ignora maiúsculas", () => {
    const r = filterLeads(leads, { ...DEFAULT_FUNNEL_FILTERS, q: "ACME" }, false);
    expect(r.map((l) => l.title)).toEqual(["Contrato Acme", "acme renovação"]);
  });

  it("filtra por prioridade e temperatura", () => {
    expect(filterLeads(leads, { ...DEFAULT_FUNNEL_FILTERS, priority: "low" }, false)).toHaveLength(1);
    expect(filterLeads(leads, { ...DEFAULT_FUNNEL_FILTERS, temp: "warm" }, false)[0].title).toBe("acme renovação");
  });

  it("filtra por responsável e por não atribuído", () => {
    expect(filterLeads(leads, { ...DEFAULT_FUNNEL_FILTERS, owner: "m1" }, false)).toHaveLength(1);
    expect(filterLeads(leads, { ...DEFAULT_FUNNEL_FILTERS, owner: "unassigned" }, false).map((l) => l.title)).toEqual([
      "Proposta Beta",
    ]);
  });

  it("unidade só vale com o módulo ligado", () => {
    const f = { ...DEFAULT_FUNNEL_FILTERS, unit: "u1" };
    expect(filterLeads(leads, f, true).map((l) => l.title)).toEqual(["Proposta Beta"]);
    expect(filterLeads(leads, f, false)).toHaveLength(3);
    expect(filterLeads(leads, { ...DEFAULT_FUNNEL_FILTERS, unit: "none" }, true).map((l) => l.title)).toEqual([
      "Contrato Acme",
    ]);
  });

  it("combina filtros (E lógico)", () => {
    const r = filterLeads(leads, { ...DEFAULT_FUNNEL_FILTERS, q: "acme", temp: "hot" }, false);
    expect(r).toHaveLength(1);
  });
});

describe("sortLeads", () => {
  const rows = [
    { title: "b", value: 10, priority: "low", temperature: "hot", stage: { name: "Z" }, assignee: { name: "Ana" }, updatedAt: 3 },
    { title: "A", value: 30, priority: "urgent", temperature: "cold", stage: { name: "a" }, assignee: null, lastActivityAt: 9 },
    { title: "c", value: 20, priority: "high", temperature: "warm", stage: { name: "M" }, assignee: { name: "bia" }, updatedAt: 5 },
  ];

  it("ordena texto sem diferenciar maiúsculas", () => {
    expect(sortLeads(rows, "title", "asc").map((r) => r.title)).toEqual(["A", "b", "c"]);
  });

  it("ordena número, prioridade e temperatura", () => {
    expect(sortLeads(rows, "value", "desc").map((r) => r.value)).toEqual([30, 20, 10]);
    expect(sortLeads(rows, "priority", "desc").map((r) => r.priority)).toEqual(["urgent", "high", "low"]);
    expect(sortLeads(rows, "temperature", "desc").map((r) => r.temperature)).toEqual(["hot", "warm", "cold"]);
  });

  it("recência usa updatedAt e cai em lastActivityAt", () => {
    expect(sortLeads(rows, "updatedAt", "desc").map((r) => r.title)).toEqual(["A", "c", "b"]);
  });

  it("não altera o array original", () => {
    const copy = [...rows];
    sortLeads(rows, "value", "asc");
    expect(rows).toEqual(copy);
  });

  it("direção padrão: texto asc, resto desc", () => {
    expect(defaultSortOrder("title")).toBe("asc");
    expect(defaultSortOrder("assignee")).toBe("asc");
    expect(defaultSortOrder("value")).toBe("desc");
  });
});

describe("funil inicial", () => {
  const boards = [{ _id: "b1" }, { _id: "b2" }, { _id: "b3" }];

  it("?board= válido vence o último visto", () => {
    expect(pickInitialBoardId(boards, "b3", "b2")).toBe("b3");
  });

  it("param inválido cai no último visto, depois no primeiro", () => {
    expect(pickInitialBoardId(boards, "zzz", "b2")).toBe("b2");
    expect(pickInitialBoardId(boards, null, "arquivado")).toBe("b1");
    expect(pickInitialBoardId(boards, null, null)).toBe("b1");
  });

  it("sem funis devolve null", () => {
    expect(pickInitialBoardId([], "b1", "b1")).toBeNull();
  });

  it("a chave do localStorage é por organização", () => {
    expect(lastBoardStorageKey("org1")).toBe("hnbcrm.lastBoard.org1");
  });
});
