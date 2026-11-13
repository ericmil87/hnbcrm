import { describe, expect, it } from "vitest";
import { buildStageGroups, stageNameById } from "./inboxStageFilter";

const boards = [
  { _id: "b1", name: "Vendas" },
  { _id: "b2", name: "Antigo", archivedAt: 5 },
  { _id: "b3", name: "Pós-venda" },
  { _id: "b4", name: "Vazio" },
];
const stages = {
  b1: [{ _id: "s1", name: "Novo" }, { _id: "s2", name: "Proposta" }],
  b2: [{ _id: "s9", name: "Velha" }],
  b3: [{ _id: "s3", name: "Novo" }],
  b4: [],
};

describe("buildStageGroups", () => {
  it("agrupa por funil ativo, sem arquivados nem funis sem etapa", () => {
    const groups = buildStageGroups(boards, stages);
    expect(groups.map((g) => g.boardName)).toEqual(["Vendas", "Pós-venda"]);
    expect(groups[0].stages.map((s) => s.name)).toEqual(["Novo", "Proposta"]);
  });

  it("ignora funil cujas etapas ainda carregam", () => {
    expect(buildStageGroups(boards, { b1: stages.b1 }).map((g) => g.boardId)).toEqual(["b1"]);
  });
});

describe("stageNameById", () => {
  const groups = buildStageGroups(boards, stages);
  it("acha o nome mesmo com nomes repetidos entre funis", () => {
    expect(stageNameById(groups, "s3")).toBe("Novo");
    expect(stageNameById(groups, "s2")).toBe("Proposta");
  });
  it("desconhecida ou nula = undefined", () => {
    expect(stageNameById(groups, "s9")).toBeUndefined();
    expect(stageNameById(groups, null)).toBeUndefined();
  });
});
