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

  it("preserva modo e busca do Funil/Agenda, mas descarta filtros com id", () => {
    expect(
      pathAfterOrgSwitch("/app/pipeline", "?view=list&q=acme&owner=m1&unit=u1&board=b1&lead=l1&temp=hot")
    ).toBe("/app/pipeline?view=list&q=acme");
    expect(pathAfterOrgSwitch("/app/calendario", "?view=week&date=2026-11-04&event=e1")).toBe(
      "/app/calendario?view=week&date=2026-11-04"
    );
  });

  it("mantém o filtro de arquivadas e derruba a etiqueta (id da org anterior)", () => {
    expect(pathAfterOrgSwitch("/app/entrada", "?archived=1&label=k17abc&conversation=c1")).toBe(
      "/app/entrada?archived=1"
    );
    expect(pathAfterOrgSwitch("/app/entrada", "?label=k17abc")).toBe("/app/entrada");
  });

  it("Tarefas: mantém modo, filtro rápido e status; derruba responsável, etiqueta e projeto", () => {
    expect(
      pathAfterOrgSwitch("/app/tarefas", "?view=status&smart=today&status=pending&assignee=m1&label=l1,l2&project=p1&task=t1")
    ).toBe("/app/tarefas?view=status&smart=today&status=pending");
  });

  it("Histórico: mantém filtros de enum e datas; derruba ator e item aberto", () => {
    expect(
      pathAfterOrgSwitch(
        "/app/auditoria",
        "?entity=lead&action=update&severity=high&from=2026-11-01&to=2026-11-04&actor=m1&log=a1"
      )
    ).toBe("/app/auditoria?entity=lead&action=update&severity=high&from=2026-11-01&to=2026-11-04");
  });

  it("Campanhas e Equipe: mantém status/canal/busca; derruba campanha e membro", () => {
    expect(pathAfterOrgSwitch("/app/campanhas", "?status=active&provider=meta&campanha=c1")).toBe(
      "/app/campanhas?status=active&provider=meta"
    );
    expect(pathAfterOrgSwitch("/app/equipe", "?q=ana&member=m1")).toBe("/app/equipe?q=ana");
  });

  it("derruba o contato aberto (id da org anterior) e mantém busca e página de Contatos", () => {
    expect(pathAfterOrgSwitch("/app/contatos", "?contact=k17abc&contactTab=leads&q=ana&page=3")).toBe(
      "/app/contatos?contactTab=leads&q=ana&page=3"
    );
    expect(pathAfterOrgSwitch("/app/contatos", "?contact=k17abc")).toBe("/app/contatos");
  });

  it("mantém as abas dos painéis de lead e contato, sem o id do lead", () => {
    expect(pathAfterOrgSwitch("/app/pipeline", "?lead=l1&leadTab=tasks&board=b1")).toBe(
      "/app/pipeline?leadTab=tasks"
    );
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
