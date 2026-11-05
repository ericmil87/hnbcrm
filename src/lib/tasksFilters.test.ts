import { describe, expect, it } from "vitest";
import {
  labelCodec,
  resolveTaskIds,
  smartCodec,
  statusCodec,
  tasksUrlWrites,
  viewCodec,
  type TasksUrlState,
} from "./tasksFilters";

const DEFAULTS: TasksUrlState = {
  view: "list",
  smart: "all",
  status: "",
  assigneeId: null,
  labelIds: [],
  projectId: null,
};

describe("codecs de Tarefas", () => {
  it("enum inválido cai no padrão", () => {
    expect(viewCodec.parse("kanban")).toBe("list");
    expect(smartCodec.parse("tomorrow")).toBe("all");
    expect(statusCodec.parse("done")).toBe("");
    expect(statusCodec.parse(null)).toBe("");
  });

  it("valores válidos passam e o padrão sai da URL", () => {
    expect(viewCodec.parse("status")).toBe("status");
    expect(smartCodec.parse("overdue")).toBe("overdue");
    expect(statusCodec.parse("in_progress")).toBe("in_progress");
    expect(viewCodec.serialize("list")).toBeNull();
    expect(smartCodec.serialize("all")).toBeNull();
    expect(statusCodec.serialize("")).toBeNull();
    expect(statusCodec.serialize("pending")).toBe("pending");
  });

  it("etiquetas são lista separada por vírgula", () => {
    expect(labelCodec.parse("a,b")).toEqual(["a", "b"]);
    expect(labelCodec.serialize([])).toBeNull();
  });
});

describe("tasksUrlWrites", () => {
  it("estado padrão remove todos os params", () => {
    expect(tasksUrlWrites(DEFAULTS)).toEqual({
      view: null,
      smart: null,
      status: null,
      assignee: null,
      label: null,
      project: null,
    });
  });

  it("escreve só o que difere do padrão", () => {
    expect(
      tasksUrlWrites({ ...DEFAULTS, view: "status", smart: "today", labelIds: ["l1", "l2"], projectId: "p1" })
    ).toEqual({
      view: "status",
      smart: "today",
      status: null,
      assignee: null,
      label: "l1,l2",
      project: "p1",
    });
  });
});

describe("resolveTaskIds", () => {
  const lists = { projectIds: ["p1"], memberIds: ["m1"], labelIds: ["l1", "l2"] };

  it("mantém ids que existem na org", () => {
    expect(resolveTaskIds({ projectId: "p1", assigneeId: "m1", labelIds: ["l1"] }, lists)).toEqual({
      projectId: "p1",
      assigneeId: "m1",
      labelIds: ["l1"],
      pending: false,
    });
  });

  it("descarta ids de outra org ou apagados", () => {
    expect(resolveTaskIds({ projectId: "x", assigneeId: "y", labelIds: ["l1", "z"] }, lists)).toEqual({
      projectId: null,
      assigneeId: null,
      labelIds: ["l1"],
      pending: false,
    });
  });

  it("projeto arquivado (fora da lista de ativos) também é descartado", () => {
    const active = { projectIds: ["p-ativo"], memberIds: ["m1"], labelIds: [] };
    expect(resolveTaskIds({ projectId: "p-arquivado", assigneeId: null, labelIds: [] }, active).projectId).toBeNull();
  });

  it("segura a consulta enquanto a lista do id carrega", () => {
    const loading = { projectIds: undefined, memberIds: undefined, labelIds: undefined };
    expect(resolveTaskIds({ projectId: "p1", assigneeId: null, labelIds: [] }, loading).pending).toBe(true);
    expect(resolveTaskIds({ projectId: null, assigneeId: null, labelIds: [] }, loading).pending).toBe(false);
  });
});
