import { describe, expect, it } from "vitest";
import {
  actionCodec,
  actorCodec,
  entityCodec,
  fromCodec,
  isIsoDate,
  resolveAuditActor,
  severityCodec,
  toCodec,
} from "./auditFilters";

describe("isIsoDate", () => {
  it("aceita dias reais", () => {
    expect(isIsoDate("2026-11-05")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true);
  });

  it("rejeita formato errado e dias que não existem", () => {
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2027-02-29")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("05/11/2026")).toBe(false);
    expect(isIsoDate("2026-1-5")).toBe(false);
    expect(isIsoDate("")).toBe(false);
  });
});

describe("codecs do Histórico", () => {
  it("datas inválidas são ignoradas", () => {
    expect(fromCodec.parse("2026-11-01")).toBe("2026-11-01");
    expect(fromCodec.parse("ontem")).toBe("");
    expect(toCodec.parse("2026-02-31")).toBe("");
    expect(toCodec.parse(null)).toBe("");
    expect(fromCodec.serialize("")).toBeNull();
    expect(fromCodec.serialize("lixo")).toBeNull();
    expect(toCodec.serialize("2026-11-04")).toBe("2026-11-04");
  });

  it("severidade e ação inválidas caem em all; o padrão sai da URL", () => {
    expect(severityCodec.parse("extreme")).toBe("all");
    expect(severityCodec.parse("high")).toBe("high");
    expect(actionCodec.parse("explode")).toBe("all");
    expect(actionCodec.parse("handoff")).toBe("handoff");
    expect(severityCodec.serialize("all")).toBeNull();
    expect(actionCodec.serialize("move")).toBe("move");
  });

  it("entidade e ator: ausente = all, e all não é escrito", () => {
    expect(entityCodec.parse(null)).toBe("all");
    expect(entityCodec.parse("lead")).toBe("lead");
    expect(entityCodec.serialize("all")).toBeNull();
    expect(actorCodec.parse("")).toBe("all");
    expect(actorCodec.serialize("m1")).toBe("m1");
  });
});

describe("resolveAuditActor", () => {
  it("sem ator na URL não espera nada", () => {
    expect(resolveAuditActor("all", undefined)).toEqual({ actor: "all", pending: false });
  });

  it("espera a lista de atores carregar", () => {
    expect(resolveAuditActor("m1", undefined)).toEqual({ actor: "all", pending: true });
  });

  it("ator que não existe na org vira sem filtro", () => {
    expect(resolveAuditActor("m1", ["m1", "m2"])).toEqual({ actor: "m1", pending: false });
    expect(resolveAuditActor("zzz", ["m1"])).toEqual({ actor: "all", pending: false });
  });
});
