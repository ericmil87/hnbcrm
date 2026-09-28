import { describe, expect, it } from "vitest";
import {
  entityDeepLink,
  newlyAddedOrgIds,
  pathAfterOrgSwitch,
  withoutSearchParam,
} from "./orgSwitch";

describe("pathAfterOrgSwitch", () => {
  it("remove deep-links de entidade e mantém a aba", () => {
    expect(pathAfterOrgSwitch("/app/entrada", "?conversation=abc")).toBe("/app/entrada");
    expect(pathAfterOrgSwitch("/app/tarefas", "?task=t1")).toBe("/app/tarefas");
    expect(pathAfterOrgSwitch("/app/pipeline", "?board=b1&lead=l1")).toBe("/app/pipeline");
    expect(pathAfterOrgSwitch("/app/repasses", "?handoff=h1")).toBe("/app/repasses");
  });

  it("preserva parâmetros só de UI", () => {
    expect(pathAfterOrgSwitch("/app/configuracoes", "?secao=data")).toBe(
      "/app/configuracoes?secao=data"
    );
    expect(pathAfterOrgSwitch("/app/grupos", "?aba=posts&post=p1")).toBe("/app/grupos?aba=posts");
  });

  it("sobe para a raiz da aba quando o caminho carrega id", () => {
    expect(pathAfterOrgSwitch("/app/formularios/f1/submissoes", "?x=1")).toBe("/app/formularios");
  });

  it("cai no painel em rota desconhecida", () => {
    expect(pathAfterOrgSwitch("/app", "")).toBe("/app/painel");
  });
});

describe("newlyAddedOrgIds", () => {
  it("primeira visita não avisa nada", () => {
    expect(newlyAddedOrgIds(null, ["a", "b"])).toEqual([]);
  });

  it("aponta só as orgs novas, ignorando a que a própria pessoa criou", () => {
    expect(newlyAddedOrgIds(["a"], ["a", "b", "c"], new Set(["c"]))).toEqual(["b"]);
  });

  it("org removida não conta como nova", () => {
    expect(newlyAddedOrgIds(["a", "b"], ["a"])).toEqual([]);
  });
});

describe("entityDeepLink / withoutSearchParam", () => {
  it("acha o deep-link de entidade e ignora parâmetros de UI", () => {
    expect(entityDeepLink("?task=t1")).toEqual({ kind: "task", id: "t1" });
    expect(entityDeepLink("?board=b1&lead=l1")).toEqual({ kind: "lead", id: "l1" });
    expect(entityDeepLink("?secao=data")).toBeNull();
    expect(entityDeepLink("?task=")).toBeNull();
  });

  it("tira só o parâmetro pedido", () => {
    expect(withoutSearchParam("/app/pipeline", "?board=b1&lead=l1", "lead")).toBe(
      "/app/pipeline?board=b1"
    );
    expect(withoutSearchParam("/app/tarefas", "?task=t1", "task")).toBe("/app/tarefas");
  });
});
