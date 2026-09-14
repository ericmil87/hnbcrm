import { describe, it, expect } from "vitest";
import {
  parseWhatsApp,
  parseInlineWa,
  waToPlainText,
  containsLink,
  renderSpintaxSample,
  countSpintaxVariations,
  substituteVars,
  extractVarNames,
  renderForRecipient,
} from "./whatsappFormat";

describe("whatsappFormat — inline", () => {
  it("negrito, itálico, riscado e mono", () => {
    const nodes = parseInlineWa("*forte* _leve_ ~fora~ `cod`");
    expect(nodes.map((n) => n.type)).toEqual([
      "bold",
      "text",
      "italic",
      "text",
      "strike",
      "text",
      "code",
    ]);
    expect(waToPlainText(nodes)).toBe("forte leve fora cod");
  });

  it("aninha itálico dentro de negrito", () => {
    const nodes = parseInlineWa("*oi _você_*");
    expect(nodes[0]).toMatchObject({ type: "bold" });
    const inner = (nodes[0] as { children: { type: string }[] }).children;
    expect(inner.map((n) => n.type)).toEqual(["text", "italic"]);
  });

  it("asterisco no meio de palavra é literal", () => {
    expect(parseInlineWa("a*b*c")).toEqual([{ type: "text", value: "a*b*c" }]);
  });

  it("abertura seguida de espaço é literal", () => {
    expect(parseInlineWa("* x*")).toEqual([{ type: "text", value: "* x*" }]);
  });

  it("fechamento precedido de espaço é literal", () => {
    expect(parseInlineWa("*x *")).toEqual([{ type: "text", value: "*x *" }]);
  });

  it("snake_case não vira itálico", () => {
    expect(parseInlineWa("lead_id_final")).toEqual([{ type: "text", value: "lead_id_final" }]);
  });

  it("sem fechamento fica literal (usuário digitando)", () => {
    expect(parseInlineWa("*negri")).toEqual([{ type: "text", value: "*negri" }]);
    expect(parseInlineWa("`cod")).toEqual([{ type: "text", value: "`cod" }]);
  });

  it("formatação não atravessa quebra de linha", () => {
    const nodes = parseInlineWa("*abc\ndef*");
    expect(nodes.map((n) => n.type)).toEqual(["text", "break", "text"]);
  });

  it("URL solta vira link, só http/https", () => {
    const nodes = parseInlineWa("veja https://hnbcrm.com/x?a=1. e ftp://nada");
    expect(nodes).toEqual([
      { type: "text", value: "veja " },
      { type: "link", href: "https://hnbcrm.com/x?a=1" },
      { type: "text", value: ". e ftp://nada" },
    ]);
  });

  it("emoji e pontuação passam", () => {
    expect(waToPlainText(parseInlineWa("Olá! 👋 *tudo bem?*"))).toBe("Olá! 👋 tudo bem?");
  });

  it("negrito ao lado de pontuação funciona", () => {
    const nodes = parseInlineWa("(*sim*)!");
    expect(nodes.map((n) => n.type)).toEqual(["text", "bold", "text"]);
  });
});

describe("whatsappFormat — blocos", () => {
  it("bloco ``` vira codeBlock com o miolo cru", () => {
    const nodes = parseWhatsApp("antes ```a *b*``` depois");
    expect(nodes.map((n) => n.type)).toEqual(["text", "codeBlock", "text"]);
    expect(nodes[1]).toEqual({ type: "codeBlock", value: "a *b*" });
  });

  it("cerca sem fechamento é literal", () => {
    const nodes = parseWhatsApp("```abc");
    expect(waToPlainText(nodes)).toBe("```abc");
  });

  it("texto vazio devolve lista vazia", () => {
    expect(parseWhatsApp("")).toEqual([]);
  });

  it("CRLF vira break", () => {
    const nodes = parseWhatsApp("a\r\nb");
    expect(nodes.map((n) => n.type)).toEqual(["text", "break", "text"]);
  });
});

describe("containsLink", () => {
  it("detecta http/https", () => {
    expect(containsLink("oi https://x.com")).toBe(true);
    expect(containsLink("oi x.com")).toBe(false);
    expect(containsLink("")).toBe(false);
  });
});

describe("spintax", () => {
  it("escolhe uma alternativa determinística por seed", () => {
    const t = "{Oi|Olá|E aí} {{nome}}";
    const a = renderSpintaxSample(t, 1);
    const b = renderSpintaxSample(t, 1);
    expect(a).toBe(b);
    expect(["Oi", "Olá", "E aí"].some((o) => a.startsWith(o))).toBe(true);
    expect(a.endsWith("{{nome}}")).toBe(true);
  });

  it("seeds diferentes cobrem alternativas diferentes", () => {
    const seen = new Set<string>();
    for (let s = 0; s < 30; s++) seen.add(renderSpintaxSample("{a|b|c}", s));
    expect(seen.size).toBe(3);
  });

  it("aninhamento e chaves sem pipe", () => {
    expect(renderSpintaxSample("{x|{y|z}}", 0)).toMatch(/^[xyz]$/);
    expect(renderSpintaxSample("{literal}", 0)).toBe("{literal}");
  });

  it("conta variações", () => {
    expect(countSpintaxVariations("{a|b} {c|d|e}")).toBe(6);
    expect(countSpintaxVariations("sem nada {{nome}}")).toBe(1);
    expect(countSpintaxVariations("{a|{b|c}}")).toBe(3);
  });
});

describe("variáveis", () => {
  it("substitui, com fallback e case-insensitive", () => {
    expect(substituteVars("Oi {{Nome}}, {{cidade|sua cidade}}!", { nome: "Ana" })).toBe(
      "Oi Ana, sua cidade!"
    );
  });

  it("missing keep vs blank", () => {
    expect(substituteVars("Oi {{nome}}", {})).toBe("Oi {{nome}}");
    expect(substituteVars("Oi {{nome}}", {}, { missing: "blank" })).toBe("Oi ");
  });

  it("valor vazio usa fallback", () => {
    expect(substituteVars("{{x|f}}", { x: "" })).toBe("f");
  });

  it("extrai nomes únicos em ordem", () => {
    expect(extractVarNames("{{a}} {{B|z}} {{a}}")).toEqual(["a", "b"]);
  });

  it("renderForRecipient combina spintax e vars", () => {
    const out = renderForRecipient("{Oi|Olá} {{nome}}", { nome: "Ana" }, 2);
    expect(out).toMatch(/^(Oi|Olá) Ana$/);
  });
});
