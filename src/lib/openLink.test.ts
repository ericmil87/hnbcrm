import { describe, expect, it } from "vitest";
import { buildOpenLink, isSafeAppPath, parseOpenLink, safeAppTarget, safeSwNavigateTarget, withOpenAction } from "./openLink";

describe("isSafeAppPath", () => {
  it("aceita caminhos internos do app, com query", () => {
    expect(isSafeAppPath("/app/entrada?conversation=abc")).toBe(true);
    expect(isSafeAppPath("/app/painel?sino=1")).toBe(true);
  });
  it.each([
    "//evil.com",
    "//evil.com/app/x",
    "/\\evil.com",
    "/app/\\evil",
    "https://evil.com/app/x",
    "http://evil.com",
    "javascript:alert(1)",
    "/entrada",
    "/app",
    "app/entrada",
    "/app/abrir?org=a&to=/app/painel",
    "/app/./abrir",
    "/app//abrir",
    "/app/x/../abrir",
    "/app/%2e/abrir?org=a",
    "/app/ABRIR",
    "/app/abrir/",
    "/app/../evil",
    "/app/x\n",
    "",
  ])("bloqueia %j", (to) => {
    expect(isSafeAppPath(to)).toBe(false);
  });
  it("null/undefined não passam", () => {
    expect(isSafeAppPath(null)).toBe(false);
    expect(isSafeAppPath(undefined)).toBe(false);
  });
});

describe("safeAppTarget", () => {
  it("devolve o caminho normalizado (pathname + search + hash)", () => {
    expect(safeAppTarget("/app/x/./y?a=1#h")).toBe("/app/x/y?a=1#h");
    expect(safeAppTarget("/app/tarefas?task=t1")).toBe("/app/tarefas?task=t1");
  });
  it("parseOpenLink entrega o destino normalizado", () => {
    expect(parseOpenLink("?org=o&to=" + encodeURIComponent("/app/a/./b"))).toEqual({ org: "o", to: "/app/a/b" });
  });
});

describe("parseOpenLink / buildOpenLink", () => {
  it("faz ida e volta com query dentro de `to`", () => {
    const link = buildOpenLink("org1", "/app/tarefas?task=t1&view=list");
    const search = link.slice(link.indexOf("?"));
    expect(parseOpenLink(search)).toEqual({ org: "org1", to: "/app/tarefas?task=t1&view=list" });
  });
  it("sem org ou com `to` externo devolve null", () => {
    expect(parseOpenLink("?to=/app/painel")).toBeNull();
    expect(parseOpenLink("?org=o&to=//evil")).toBeNull();
    expect(parseOpenLink("?org=o")).toBeNull();
  });
});

describe("acao do push e mensagens do service worker", () => {
  it("parseOpenLink lê acao=assumir e ignora valores desconhecidos", () => {
    expect(parseOpenLink("?org=o&to=" + encodeURIComponent("/app/repasses?handoff=h1") + "&acao=assumir")).toEqual({
      org: "o",
      to: "/app/repasses?handoff=h1",
      acao: "assumir",
    });
    expect(parseOpenLink("?org=o&to=/app/painel&acao=apagar")).toEqual({ org: "o", to: "/app/painel" });
  });
  it("withOpenAction põe acao na query do destino", () => {
    expect(withOpenAction("/app/repasses?handoff=h1", "assumir")).toBe("/app/repasses?handoff=h1&acao=assumir");
    expect(withOpenAction("/app/repasses", undefined)).toBe("/app/repasses");
  });
  it("safeSwNavigateTarget aceita /app/abrir válido e URL absoluta da mesma origem", () => {
    const o = "https://hnbcrm.com";
    const open = buildOpenLink("org1", "/app/entrada?conversation=c1");
    expect(safeSwNavigateTarget(open, o)).toBe(open);
    expect(safeSwNavigateTarget(o + open, o)).toBe(open);
    expect(safeSwNavigateTarget("/app/tarefas?task=t1", o)).toBe("/app/tarefas?task=t1");
  });
  it.each(["https://evil.com/app/painel", "//evil.com", "/entrar", "javascript:alert(1)", "/app/abrir?org=o&to=//evil", "/app/abrir", "", 42, null])(
    "safeSwNavigateTarget recusa %s",
    (u) => {
      expect(safeSwNavigateTarget(u, "https://hnbcrm.com")).toBeNull();
    },
  );
});
