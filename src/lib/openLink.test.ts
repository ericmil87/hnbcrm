import { describe, expect, it } from "vitest";
import { buildOpenLink, isSafeAppPath, parseOpenLink } from "./openLink";

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
