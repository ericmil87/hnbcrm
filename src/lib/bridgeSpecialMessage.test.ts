import { describe, expect, it } from "vitest";
import {
  conversationPreviewText,
  describeSpecialMessage,
  safeHttpUrl,
} from "./bridgeSpecialMessage";

describe("describeSpecialMessage", () => {
  it("devolve null para mensagem comum", () => {
    expect(describeSpecialMessage({ bridgeType: "text" }, "oi")).toBeNull();
    expect(describeSpecialMessage(undefined, "oi")).toBeNull();
  });

  it("álbum", () => {
    const r = describeSpecialMessage({ bridgeType: "album", bridgeExtra: { imageCount: 20, videoCount: 0 } }, "")!;
    expect(r.previewLabel).toBe("Álbum com 20 fotos");
    const one = describeSpecialMessage({ bridgeType: "album", bridgeExtra: { imageCount: 1, videoCount: 2 } }, "")!;
    expect(one.title).toBe("Álbum com 1 foto e 2 vídeos");
  });

  it("enquete", () => {
    const r = describeSpecialMessage(
      { bridgeType: "poll", bridgeExtra: { question: "Almoço?", options: ["Sim", "Não"], selectableCount: 1 } },
      "[enquete: Almoço?]"
    )!;
    expect(r.options).toEqual(["Sim", "Não"]);
    expect(r.previewLabel).toBe("Enquete: Almoço?");
  });

  it("localização gera link de mapa e prefere url http", () => {
    const r = describeSpecialMessage({ bridgeType: "location", bridgeExtra: { latitude: -3.7, longitude: -38.5, name: "Praia" } }, "")!;
    expect(r.actions?.[0].href).toBe("https://www.google.com/maps?q=-3.7,-38.5");
    const u = describeSpecialMessage(
      { bridgeType: "location", bridgeExtra: { latitude: 1, longitude: 2, url: "https://maps.example/x" } },
      ""
    )!;
    expect(u.actions?.[0].href).toBe("https://maps.example/x");
    const bad = describeSpecialMessage(
      { bridgeType: "location", bridgeExtra: { latitude: 1, longitude: 2, url: "javascript:alert(1)" } },
      ""
    )!;
    expect(bad.actions?.[0].href).toBe("https://www.google.com/maps?q=1,2");
  });

  it("localização sem coordenadas não tem ação", () => {
    const r = describeSpecialMessage({ bridgeType: "location" }, "")!;
    expect(r.actions).toBeUndefined();
  });

  it("contato formata telefones", () => {
    const r = describeSpecialMessage({ bridgeType: "contact", bridgeExtra: { names: ["Ana"], phones: ["5585999991234"] } }, "")!;
    expect(r.previewLabel).toBe("Contato: Ana");
    expect(r.phones?.[0].raw).toBe("5585999991234");
    expect(r.phones?.[0].display).toContain("85");
  });

  it("evento com link de participar", () => {
    const r = describeSpecialMessage(
      { bridgeType: "event", bridgeExtra: { name: "Roda", startAt: Date.UTC(2026, 9, 10, 15), joinLink: "https://call.example/1" } },
      ""
    )!;
    expect(r.previewLabel).toBe("Evento: Roda");
    expect(r.lines[0]).toMatch(/2026/);
    expect(r.actions?.[0].label).toBe("Participar");
  });

  it("convite, chamada, resposta de botão e desconhecido", () => {
    expect(describeSpecialMessage({ bridgeType: "group_invite", bridgeExtra: { groupName: "G" } }, "")!.previewLabel).toBe("Convite para grupo");
    expect(describeSpecialMessage({ bridgeType: "call_log", bridgeExtra: { isVideo: true } }, "")!.previewLabel).toBe("Chamada de vídeo");
    expect(describeSpecialMessage({ bridgeType: "call_log" }, "")!.previewLabel).toBe("Chamada de voz");
    expect(describeSpecialMessage({ bridgeType: "interactive_reply", bridgeExtra: { selected: "Opção 2" } }, "Opção 2")!.title).toBe("Opção 2");
  });

  it("dado antigo sem bridgeExtra continua renderizando", () => {
    const r = describeSpecialMessage({ bridgeType: "unknown" }, "[mensagem não suportada]")!;
    expect(r.kind).toBe("unknown");
    expect(r.previewLabel).toBe("Mensagem de tipo não suportado");
    expect(describeSpecialMessage({ bridgeType: "poll" }, "[enquete: X]")!.title).toBe("X");
    expect(describeSpecialMessage({ bridgeType: "album" }, "[álbum]")!.title).toBe("Álbum");
  });

  it("mensagem apagada vence qualquer tipo", () => {
    const r = describeSpecialMessage({ revoked: true, bridgeType: "text" }, "segredo")!;
    expect(r.kind).toBe("revoked");
    expect(r.previewLabel).toBe("Mensagem apagada");
  });
});

describe("safeHttpUrl", () => {
  it("só aceita http/https", () => {
    expect(safeHttpUrl("ftp://x")).toBeUndefined();
    expect(safeHttpUrl("nada")).toBeUndefined();
    expect(safeHttpUrl("http://a.com")).toBe("http://a.com/");
  });
});

describe("conversationPreviewText", () => {
  it("troca o placeholder desconhecido", () => {
    expect(conversationPreviewText("[mensagem não suportada]", "unknown")).toBe("Mensagem de tipo não suportado");
    expect(conversationPreviewText("oi", "text")).toBe("oi");
    expect(conversationPreviewText("[enquete: Q]", "poll")).toBe("Enquete: Q");
    expect(conversationPreviewText("x", "text", true)).toBe("Mensagem apagada");
  });
});
