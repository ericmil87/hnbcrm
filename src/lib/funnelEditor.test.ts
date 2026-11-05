import { describe, expect, it } from "vitest";
import { segmentTemplate } from "../../convex/lib/onboardingTemplates";
import {
  addStage,
  canMoveStage,
  canRemoveStage,
  fromBoard,
  fromTemplate,
  sameFunnel,
  moveStage,
  removeStage,
  renameStage,
  toApplyFunnelTemplateArgs,
  validateFunnel,
  type FunnelValue,
} from "./funnelEditor";

const base = (): FunnelValue => ({
  boardName: "Funil de vendas",
  boardColor: "#3B82F6",
  stages: [
    { key: "a", name: "Novo", color: "#3B82F6" },
    { key: "b", name: "Proposta", color: "#F59E0B" },
    { key: "w", name: "Ganho", color: "#10B981", isClosedWon: true },
    { key: "l", name: "Perdido", color: "#6B7280", isClosedLost: true },
  ],
});

describe("fromBoard e sameFunnel", () => {
  it("ordena as etapas por order e reconhece o mesmo funil sem olhar as chaves", () => {
    const value = fromBoard(
      { name: "Funil", color: "#3B82F6" },
      [
        { name: "B", color: "#111111", order: 1 },
        { name: "A", color: "#222222", order: 0 },
        { name: "G", color: "#333333", order: 2, isClosedWon: true },
      ],
    );
    expect(value.stages.map((s) => s.name)).toEqual(["A", "B", "G"]);
    expect(value.stages[2].isClosedWon).toBe(true);
    const copy = { ...value, stages: value.stages.map((s) => ({ ...s, key: s.key + "x" })) };
    expect(sameFunnel(value, copy)).toBe(true);
    expect(sameFunnel(value, renameStage(value, value.stages[0].key, "Z"))).toBe(false);
  });
});

describe("funnelEditor", () => {
  it("renomeia só a etapa pedida", () => {
    const next = renameStage(base(), "b", "Orçamento");
    expect(next.stages.map((s) => s.name)).toEqual(["Novo", "Orçamento", "Ganho", "Perdido"]);
  });

  it("move etapas e nunca deixa uma fechada na primeira posição", () => {
    const v = base();
    expect(moveStage(v, "b", -1).stages.map((s) => s.key)).toEqual(["b", "a", "w", "l"]);
    expect(canMoveStage(v, "w", -1)).toBe(true);
    expect(canMoveStage(v, "a", -1)).toBe(false);
    expect(canMoveStage(v, "l", 1)).toBe(false);
    const two: FunnelValue = { ...v, stages: [v.stages[0], v.stages[2]] };
    expect(canMoveStage(two, "a", 1)).toBe(false);
    expect(canMoveStage(two, "w", -1)).toBe(false);
    expect(moveStage(two, "a", 1)).toBe(two);
  });

  it("adiciona antes da primeira etapa fechada e respeita o máximo", () => {
    const next = addStage(base(), 12, "n");
    expect(next.stages.map((s) => s.key)).toEqual(["a", "b", "n", "w", "l"]);
    expect(next.stages[2].isClosedWon).toBeUndefined();
    const full = { ...base(), stages: Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, name: `E${i}`, color: "#000000" })) };
    expect(addStage(full)).toBe(full);
  });

  it("remove respeitando mínimo de 2 e a última etapa aberta", () => {
    const v = base();
    expect(removeStage(v, "b").stages).toHaveLength(3);
    expect(canRemoveStage(v, "w")).toBe(true);
    const oneOpen: FunnelValue = { ...v, stages: [v.stages[0], v.stages[2], v.stages[3]] };
    expect(canRemoveStage(oneOpen, "a")).toBe(false);
    expect(removeStage(oneOpen, "a")).toBe(oneOpen);
    const two: FunnelValue = { ...v, stages: [v.stages[0], v.stages[1]] };
    expect(canRemoveStage(two, "b")).toBe(false);
  });

  it("fromTemplate usa o funil do segmento, com chaves únicas", () => {
    const t = segmentTemplate("imobiliaria");
    const v = fromTemplate(t);
    expect(v.boardName).toBe(t.funnel.boardName);
    expect(v.stages.map((s) => s.name)).toEqual(t.funnel.stages.map((s) => s.name));
    expect(new Set(v.stages.map((s) => s.key)).size).toBe(v.stages.length);
    expect(validateFunnel(v).ok).toBe(true);
  });

  it("todos os segmentos geram funil válido", () => {
    for (const key of ["imobiliaria", "saas", "servicos", "saude", "ecommerce", "educacao", "outro"]) {
      expect(validateFunnel(fromTemplate(segmentTemplate(key))).ok).toBe(true);
    }
  });

  it("validateFunnel aponta erros por campo em português", () => {
    const v = base();
    const { ok, errors } = validateFunnel({ ...v, boardName: "  ", stages: [{ ...v.stages[0], name: "" }, v.stages[1]] });
    expect(ok).toBe(false);
    expect(errors.boardName).toBe("Dê um nome ao funil");
    expect(errors.stages.a).toBe("Dê um nome à etapa");

    expect(validateFunnel({ ...v, stages: [v.stages[0]] }).errors.form).toMatch(/pelo menos 2/);
    expect(validateFunnel({ ...v, stages: [v.stages[2], v.stages[0]] }).errors.form).toMatch(/primeira etapa/);
    expect(validateFunnel({ ...v, stages: [v.stages[0], v.stages[2], { ...v.stages[2], key: "w2" }] }).errors.form).toMatch(/uma etapa ganha/);
    const many = Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, name: `E${i}`, color: "#000000" }));
    expect(validateFunnel({ ...v, stages: many }).errors.form).toMatch(/no máximo 12/);
  });

  it("toApplyFunnelTemplateArgs devolve o shape do validator, sem chaves de cliente", () => {
    const t = segmentTemplate("saude");
    const args = toApplyFunnelTemplateArgs(fromTemplate(t), t.fields);
    expect(Object.keys(args).sort()).toEqual(["boardColor", "boardName", "fields", "stages"]);
    for (const s of args.stages) {
      expect(Object.keys(s).every((k) => ["name", "color", "isClosedWon", "isClosedLost"].includes(k))).toBe(true);
    }
    expect(args.fields?.[0]).toHaveProperty("name");
    expect(args.fields?.[0]).not.toHaveProperty("label");
  });

  it("toApplyFunnelTemplateArgs apara nomes e omite campos vazios", () => {
    const v = renameStage({ ...base(), boardName: " Meu funil " }, "a", " Novo ");
    const args = toApplyFunnelTemplateArgs(v, []);
    expect(args.boardName).toBe("Meu funil");
    expect(args.stages[0]).toEqual({ name: "Novo", color: "#3B82F6" });
    expect(args).not.toHaveProperty("fields");
  });
});
