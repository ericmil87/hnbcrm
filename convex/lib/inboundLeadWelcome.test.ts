import { describe, expect, test } from "vitest";
import {
  pickWelcomeMessage,
  renderWelcomeTemplate,
  resolveInboundRoutingRule,
  shouldSendWelcome,
  tagValue,
} from "./inboundLeadWelcome";

const settings = {
  enabled: true,
  channelConfigId: "cfg",
  requireAnyTag: ["optin:whatsapp", "contato:inscricao"],
  messages: [
    { matchTag: "evento:retiro", text: "Oi {primeiroNome}! Sobre o retiro…" },
    { matchTag: "*", text: "Oi {primeiroNome}, recebemos seu contato." },
  ],
};

describe("pickWelcomeMessage", () => {
  test("primeira matchTag presente vence; sem casar cai no '*'", () => {
    expect(pickWelcomeMessage(settings, ["Evento:Retiro"])).toContain("retiro");
    expect(pickWelcomeMessage(settings, ["outra"])).toContain("recebemos");
  });
  test("sem '*' e sem casar → null; texto vazio é ignorado", () => {
    expect(pickWelcomeMessage({ messages: [{ matchTag: "a", text: "x" }] }, ["b"])).toBeNull();
    expect(pickWelcomeMessage({ messages: [{ matchTag: "a", text: "  " }, { matchTag: "*", text: "padrão" }] }, ["a"])).toBe("padrão");
  });
});

describe("shouldSendWelcome", () => {
  test("exige ligado + telefone + tag de requireAnyTag", () => {
    expect(shouldSendWelcome(settings, { hasPhone: true, tags: ["optin:whatsapp"] })).toBe(true);
    expect(shouldSendWelcome(settings, { hasPhone: false, tags: ["optin:whatsapp"] })).toBe(false);
    expect(shouldSendWelcome(settings, { hasPhone: true, tags: ["newsletter"] })).toBe(false);
    expect(shouldSendWelcome({ ...settings, enabled: false }, { hasPhone: true, tags: ["optin:whatsapp"] })).toBe(false);
    expect(shouldSendWelcome(null, { hasPhone: true, tags: ["optin:whatsapp"] })).toBe(false);
  });
  test("requireAnyTag vazio = nunca envia (fail-closed)", () => {
    expect(shouldSendWelcome({ ...settings, requireAnyTag: [] }, { hasPhone: true, tags: ["x"] })).toBe(false);
  });
});

describe("renderWelcomeTemplate", () => {
  test("variáveis e tag por prefixo", () => {
    const out = renderWelcomeTemplate(
      "Oi {primeiroNome}! {nome} — {titulo} ({tag:modalidade})",
      { firstName: "Ana Paula", name: "Ana Paula Souza", title: "Retiro", tags: ["modalidade:cartao-parcelado"] }
    );
    expect(out).toBe("Oi Ana! Ana Paula Souza — Retiro (cartao-parcelado)");
  });
  test("primeiroNome cai no nome quando não há firstName; ausente vira vazio e a pontuação se ajeita", () => {
    expect(renderWelcomeTemplate("Oi {primeiroNome}!", { name: "João Silva" })).toBe("Oi João!");
    expect(renderWelcomeTemplate("Oi {primeiroNome}, tudo bem?", {})).toBe("Oi, tudo bem?");
  });
  test("placeholder desconhecido some; quebra de linha preservada", () => {
    expect(renderWelcomeTemplate("Olá {xpto}\nLinha 2 {tag:nada}", { tags: [] })).toBe("Olá\nLinha 2");
  });
});

describe("tagValue / resolveInboundRoutingRule", () => {
  test("tagValue sem caixa no prefixo", () => {
    expect(tagValue(["Modalidade:pix"], "modalidade")).toBe("pix");
    expect(tagValue(["x"], "modalidade")).toBe("");
  });
  test("primeira regra cuja tag está no lead", () => {
    const routing = {
      rules: [
        { tag: "evento:retiro", boardId: "b1", stageId: "s1" },
        { tag: "optin:whatsapp", boardId: "b2", stageId: "s2" },
      ],
    };
    expect(resolveInboundRoutingRule(routing, ["optin:whatsapp", "evento:retiro"])?.boardId).toBe("b1");
    expect(resolveInboundRoutingRule(routing, ["OPTIN:WHATSAPP"])?.boardId).toBe("b2");
    expect(resolveInboundRoutingRule(routing, ["nada"])).toBeNull();
    expect(resolveInboundRoutingRule(undefined, ["nada"])).toBeNull();
  });
});
