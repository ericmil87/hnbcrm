import { describe, expect, it } from "vitest";
import {
  RELATION_PARAM,
  RELATION_PARAM_VALUES,
  BULK_RELATION_CHUNK,
  bulkProgressText,
  chunk,
  bulkRelationChangedText,
  bulkRelationSheetTitle,
  bulkRelationTargets,
  bulkUndoGroups,
  commonCurrentRelation,
  commonPreviousRelation,
  contactsRelationChips,
  contactsRelationEmptyMessage,
  matchesRelationFilter,
  nextContactsRelation,
  relationArgs,
  relationBadge,
  relationEmptyMessage,
  relationFilterFromParam,
  relationParamFromFilter,
  type RelationFilter,
} from "./contactRelationList";
import { CONTACT_RELATION_FILTERS } from "../../convex/lib/contactRelationFilter";

describe("filtro por tipo: URL ↔ servidor", () => {
  it("?tipo= em PT-BR mapeia ida e volta para o arg do servidor", () => {
    expect(RELATION_PARAM).toEqual({
      leads: "leads",
      personal: "pessoais",
      team: "equipe",
      supplier: "fornecedores",
      partner: "parceiros",
      automated: "robos",
      none: "semtipo",
    });
    for (const [filter, param] of Object.entries(RELATION_PARAM) as [RelationFilter, string][]) {
      expect(relationFilterFromParam(param)).toBe(filter);
      expect(relationParamFromFilter(filter)).toBe(param);
    }
    expect(RELATION_PARAM_VALUES[0]).toBe("");
  });

  it("lixo, vazio ou o nome do servidor na URL = sem filtro", () => {
    expect(relationFilterFromParam(null)).toBeNull();
    expect(relationFilterFromParam("")).toBeNull();
    expect(relationFilterFromParam("personal")).toBeNull();
    expect(relationFilterFromParam("customer")).toBeNull();
    expect(relationParamFromFilter(null)).toBeNull();
  });

  it("todo filtro da tela é aceito pelo validator do servidor", () => {
    for (const filter of Object.keys(RELATION_PARAM)) {
      expect(CONTACT_RELATION_FILTERS as readonly string[]).toContain(filter);
    }
  });

  it("arg do servidor só com filtro (sem filtro a query não muda)", () => {
    expect(relationArgs(null)).toEqual({});
    expect(relationArgs("personal")).toEqual({ relation: "personal" });
  });

  it("critério em memória igual ao do servidor", () => {
    expect(matchesRelationFilter(undefined, "leads")).toBe(true);
    expect(matchesRelationFilter("customer", "leads")).toBe(true);
    expect(matchesRelationFilter("team", "leads")).toBe(false);
    expect(matchesRelationFilter("team", "personal")).toBe(true);
    expect(matchesRelationFilter("automated", "personal")).toBe(true);
    expect(matchesRelationFilter("customer", "personal")).toBe(false);
    expect(matchesRelationFilter(undefined, "none")).toBe(true);
    expect(matchesRelationFilter("customer", "none")).toBe(false);
    expect(matchesRelationFilter("supplier", "supplier")).toBe(true);
    expect(matchesRelationFilter("partner", "supplier")).toBe(false);
    expect(matchesRelationFilter("qualquer", null)).toBe(true);
  });

  it("estado vazio: dica de como marcar só nos tipos fora do comercial", () => {
    expect(relationEmptyMessage("personal").hint).toMatch(/Não é cliente…/);
    expect(relationEmptyMessage("leads").hint).toBeUndefined();
    expect(relationEmptyMessage("none").hint).toBeUndefined();
    expect(contactsRelationEmptyMessage("personal").title).toBe("Nenhum contato pessoal");
    expect(contactsRelationEmptyMessage("team").title).toBe("Nenhum contato em Equipe");
  });
});

describe("selo da linha", () => {
  it("bolinha + nome para os tipos fora do comercial, com token do tema", () => {
    expect(relationBadge("personal")).toEqual({ relation: "personal", label: "Pessoal", dotClass: "bg-semantic-info" });
    expect(relationBadge("team")?.label).toBe("Equipe");
    expect(relationBadge("supplier")?.label).toBe("Fornecedor");
    expect(relationBadge("partner")?.label).toBe("Parceiro");
    expect(relationBadge("automated")?.label).toBe("Robô");
  });

  it("lead, sem tipo e valor desconhecido = sem selo", () => {
    expect(relationBadge("customer")).toBeNull();
    expect(relationBadge(undefined)).toBeNull();
    expect(relationBadge(null)).toBeNull();
    expect(relationBadge("vip")).toBeNull();
  });

  it("cores só de tokens (nunca paleta crua) e distintas entre si", () => {
    const classes = ["personal", "team", "supplier", "partner", "automated"].map((r) => relationBadge(r)!.dotClass);
    expect(new Set(classes).size).toBe(5);
    for (const c of classes) expect(c).toMatch(/^bg-(semantic-(info|warning|success)|brand-500|ai-500|text-muted)$/);
  });
});

describe("ações em lote", () => {
  const rows = [
    { _id: "c1", contact: { _id: "k1", relation: "personal" } },
    { _id: "c2", contact: { _id: "k2" }, contactRelation: "team" },
    { _id: "c3", kind: "group" },
    { _id: "c4", contact: { _id: "k1", relation: "personal" } },
    { _id: "c5", contact: { _id: "k3" } },
  ];

  it("contatos únicos das conversas 1:1 selecionadas; grupo não entra", () => {
    const t = bulkRelationTargets(rows, new Set(["c1", "c2", "c3", "c4"]));
    expect(t.contactIds).toEqual(["k1", "k2"]);
    expect(t.previous).toEqual(["personal", "team"]);
    expect(t.allOffBusiness).toBe(true);
    expect(t.skipped).toBe(1);
  });

  it("'Virar lead' só quando todos os selecionados não são clientes", () => {
    expect(bulkRelationTargets(rows, new Set(["c1", "c5"])).allOffBusiness).toBe(false);
    expect(bulkRelationTargets(rows, new Set(["c3"])).allOffBusiness).toBe(false);
    expect(bulkRelationTargets(rows, new Set(["c3"])).contactIds).toEqual([]);
  });

  it("tipo comum (marca na folha) só quando todos têm o mesmo", () => {
    expect(commonPreviousRelation(["personal", "personal"])).toBe("personal");
    expect(commonPreviousRelation([null, null])).toBeNull();
    expect(commonPreviousRelation(["personal", null])).toBeUndefined();
    expect(commonPreviousRelation([])).toBeUndefined();
    expect(commonCurrentRelation([null, null])).toBeUndefined();
    expect(commonCurrentRelation(["team"])).toBe("team");
  });

  it("Desfazer: uma chamada por tipo anterior, só itens alterados, restoreLeadIds sempre presente", () => {
    const groups = bulkUndoGroups([
      { contactId: "k1", status: "changed", previous: null, archivedLeadIds: ["l1", "l2"] },
      { contactId: "k2", status: "changed", previous: "team", archivedLeadIds: [] },
      { contactId: "k3", status: "unchanged", previous: "personal", archivedLeadIds: [] },
      { contactId: "k4", status: "not_found", previous: null, archivedLeadIds: [] },
      { contactId: "k5", status: "changed", previous: null, archivedLeadIds: ["l3"] },
    ]);
    expect(groups).toEqual([
      { relation: null, contactIds: ["k1", "k5"], restoreLeadIds: ["l1", "l2", "l3"] },
      { relation: "team", contactIds: ["k2"], restoreLeadIds: [] },
    ]);
    expect(bulkUndoGroups([{ contactId: "k1", status: "unchanged", previous: null, archivedLeadIds: [] }])).toEqual([]);
  });

  it("seleção grande vira fatias de 50, na ordem", () => {
    const ids = Array.from({ length: 120 }, (_, i) => `k${i}`);
    const parts = chunk(ids);
    expect(BULK_RELATION_CHUNK).toBe(50);
    expect(parts.map((p) => p.length)).toEqual([50, 50, 20]);
    expect(parts.flat()).toEqual(ids);
    expect(chunk([])).toEqual([]);
  });

  it("Desfazer fatiado: cada fatia leva só os leads dos seus contatos", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      contactId: `k${i}`,
      status: "changed" as const,
      previous: i === 4 ? ("team" as const) : null,
      archivedLeadIds: [`l${i}`],
    }));
    expect(bulkUndoGroups(items, 2)).toEqual([
      { relation: null, contactIds: ["k0", "k1"], restoreLeadIds: ["l0", "l1"] },
      { relation: null, contactIds: ["k2", "k3"], restoreLeadIds: ["l2", "l3"] },
      { relation: "team", contactIds: ["k4"], restoreLeadIds: ["l4"] },
    ]);
  });

  it("resumo e textos do lote", () => {
    expect(bulkProgressText(50, 120)).toBe("Alterando 50 de 120 contatos…");
    expect(bulkRelationChangedText(3, "personal")).toBe("3 contatos agora estão como Pessoal");
    expect(bulkRelationChangedText(2, "customer")).toBe("2 contatos agora são leads");
    expect(bulkRelationChangedText(1, "customer")).toBe("1 contato agora é lead");
    expect(bulkRelationChangedText(4, null)).toBe("4 contatos agora estão sem tipo");
    expect(bulkRelationSheetTitle(1)).toBe("Quem é este contato?");
    expect(bulkRelationSheetTitle(5)).toBe("Quem são esses 5 contatos?");
  });
});

describe("chips da página Contatos", () => {
  it("Todos · Leads · Pessoais · Sem tipo; Todos marcado sem filtro", () => {
    expect(contactsRelationChips(null).map((c) => [c.label, c.pressed])).toEqual([
      ["Todos", true],
      ["Leads", false],
      ["Pessoais", false],
      ["Sem tipo", false],
    ]);
    expect(contactsRelationChips("personal").find((c) => c.id === "personal")?.pressed).toBe(true);
  });

  it("tipo da URL sem chip entra marcado com ✕", () => {
    const chips = contactsRelationChips("team");
    expect(chips[chips.length - 1]).toEqual({ id: "team", label: "Equipe", pressed: true, removable: true });
    expect(chips[0].pressed).toBe(false);
  });

  it("tocar: Todos e o marcado desligam; outro liga; lixo mantém", () => {
    expect(nextContactsRelation("leads", null)).toBe("leads");
    expect(nextContactsRelation("leads", "leads")).toBeNull();
    expect(nextContactsRelation("all", "none")).toBeNull();
    expect(nextContactsRelation("none", "leads")).toBe("none");
    expect(nextContactsRelation("xyz", "leads")).toBe("leads");
  });
});
