import { describe, expect, it } from "vitest";
import { campaignProviderCodec, campaignStatusCodec } from "./campaignFilters";
import { actionCodec, entityCodec, fromCodec, logCodec, severityCodec, toCodec } from "./auditFilters";
import { labelCodec, smartCodec, statusCodec, viewCodec } from "./tasksFilters";
import {
  beginWrite,
  booleanParam,
  type InFlightWrite,
  enumParam,
  listParam,
  numberParam,
  settleWrite,
  stringParam,
  writeParams,
} from "./searchParamState";

describe("stringParam", () => {
  it("vazio e ausente viram null", () => {
    expect(stringParam.parse(null)).toBeNull();
    expect(stringParam.parse("")).toBeNull();
    expect(stringParam.parse("abc")).toBe("abc");
    expect(stringParam.serialize(null)).toBeNull();
    expect(stringParam.serialize("")).toBeNull();
    expect(stringParam.serialize("abc")).toBe("abc");
  });
});

describe("enumParam", () => {
  const codec = enumParam(["board", "list"] as const, "board");
  it("valor fora da lista cai no padrão", () => {
    expect(codec.parse("list")).toBe("list");
    expect(codec.parse("kanban")).toBe("board");
    expect(codec.parse(null)).toBe("board");
  });
  it("o padrão não é escrito na URL", () => {
    expect(codec.serialize("board")).toBeNull();
    expect(codec.serialize("list")).toBe("list");
  });
});

describe("booleanParam", () => {
  it("só 1 é verdadeiro", () => {
    expect(booleanParam.parse("1")).toBe(true);
    expect(booleanParam.parse("true")).toBe(false);
    expect(booleanParam.parse(null)).toBe(false);
  });
  it("falso remove o param", () => {
    expect(booleanParam.serialize(true)).toBe("1");
    expect(booleanParam.serialize(false)).toBeNull();
  });
});

describe("numberParam", () => {
  it("lê inteiros e rejeita o resto", () => {
    const codec = numberParam({ min: 1 });
    expect(codec.parse("3")).toBe(3);
    expect(codec.parse("0")).toBeNull();
    expect(codec.parse("2.5")).toBeNull();
    expect(codec.parse("abc")).toBeNull();
    expect(codec.parse("")).toBeNull();
    expect(codec.parse(null)).toBeNull();
  });
  it("aceita decimais quando pedido e respeita o máximo", () => {
    const codec = numberParam({ integer: false, max: 10 });
    expect(codec.parse("2.5")).toBe(2.5);
    expect(codec.parse("11")).toBeNull();
  });
  it("serializa número e remove null", () => {
    const codec = numberParam();
    expect(codec.serialize(4)).toBe("4");
    expect(codec.serialize(null)).toBeNull();
    expect(codec.serialize(Number.NaN)).toBeNull();
  });
});

describe("listParam", () => {
  it("separa por vírgula e ignora itens vazios", () => {
    expect(listParam.parse("a,b,,c")).toEqual(["a", "b", "c"]);
    expect(listParam.parse("")).toEqual([]);
    expect(listParam.parse(null)).toEqual([]);
  });
  it("lista vazia remove o param", () => {
    expect(listParam.serialize(["a", "b"])).toBe("a,b");
    expect(listParam.serialize([])).toBeNull();
    expect(listParam.serialize([""])).toBeNull();
  });
});

describe("writeParams", () => {
  it("aplica várias escritas de uma vez e preserva o resto", () => {
    const prev = new URLSearchParams("conversation=old&nova=1&archived=1&x=y");
    const next = writeParams(prev, { conversation: "new", nova: null, archived: null });
    expect(next.toString()).toBe("conversation=new&x=y");
    expect(prev.get("nova")).toBe("1");
  });
});

describe("escrita em voo", () => {
  it("sem escrita pendente nunca segura o efeito", () => {
    expect(settleWrite(null, "a")).toEqual({ inFlight: null, hold: false });
  });

  it("corrida: escrita pedida, URL ainda antiga, o efeito não reverte", () => {
    // URL em ?conversation=a; clique em b: estado vira b e a escrita é pedida.
    let inFlight: InFlightWrite | null = beginWrite("a", "b");
    // Render intermediário: a URL ainda mostra "a" (valor antigo).
    let step = settleWrite(inFlight, "a");
    expect(step.hold).toBe(true);
    inFlight = step.inFlight;
    expect(inFlight).not.toBeNull();
    // Mesmo se o render se repetir antes de o router aplicar a escrita.
    step = settleWrite(inFlight, "a");
    expect(step.hold).toBe(true);
    inFlight = step.inFlight;
    // A URL alcança o alvo: resolve e o efeito volta a valer.
    step = settleWrite(inFlight, "b");
    expect(step).toEqual({ inFlight: null, hold: false });
  });

  it("fechar (alvo null) com a URL ainda antiga também segura", () => {
    const inFlight = beginWrite("a", null);
    expect(settleWrite(inFlight, "a").hold).toBe(true);
    expect(settleWrite(inFlight, null)).toEqual({ inFlight: null, hold: false });
  });

  it("mudança por fora no meio do caminho descarta a escrita pendente", () => {
    const inFlight = beginWrite("a", "b");
    expect(settleWrite(inFlight, "z")).toEqual({ inFlight: null, hold: false });
  });

  it("escrita sem efeito (alvo igual ao atual) resolve na hora", () => {
    const inFlight = beginWrite("a", "a");
    expect(settleWrite(inFlight, "a")).toEqual({ inFlight: null, hold: false });
  });

  it("de nenhum param para um alvo: a URL vazia é o valor antigo", () => {
    const inFlight = beginWrite(null, "b");
    expect(settleWrite(inFlight, null).hold).toBe(true);
    expect(settleWrite(inFlight, "b").hold).toBe(false);
  });
});

describe("params de filtro das telas (tipos e padrões)", () => {
  it("Tarefas: view, smart e status são enums com padrão fora da URL", () => {
    expect([viewCodec.parse(null), smartCodec.parse(null), statusCodec.parse(null)]).toEqual(["list", "all", ""]);
    expect([viewCodec.serialize("list"), smartCodec.serialize("all"), statusCodec.serialize("")]).toEqual([
      null,
      null,
      null,
    ]);
    expect(labelCodec.parse("a,b")).toEqual(["a", "b"]);
  });

  it("Histórico: enums, datas e item aberto", () => {
    expect([severityCodec.parse(null), actionCodec.parse(null), entityCodec.parse(null)]).toEqual([
      "all",
      "all",
      "all",
    ]);
    expect([fromCodec.parse("x"), toCodec.parse("2026-11-04")]).toEqual(["", "2026-11-04"]);
    expect(logCodec.parse(null)).toBeNull();
    expect(logCodec.parse("log1")).toBe("log1");
  });

  it("Campanhas: status e canal", () => {
    expect(campaignStatusCodec.parse("active")).toBe("active");
    expect(campaignStatusCodec.parse("scheduled")).toBe("all");
    expect(campaignStatusCodec.serialize("all")).toBeNull();
    expect(campaignProviderCodec.parse("bridge")).toBe("bridge");
    expect(campaignProviderCodec.parse("sms")).toBe("all");
    expect(campaignProviderCodec.serialize("all")).toBeNull();
  });

  it("Equipe: member e q usam stringParam (vazio = ausente)", () => {
    expect(stringParam.parse("")).toBeNull();
    expect(stringParam.serialize("ana")).toBe("ana");
  });
});
