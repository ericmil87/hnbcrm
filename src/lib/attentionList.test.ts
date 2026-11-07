import { describe, expect, it } from "vitest";
import {
  ATTENTION_LATE_AFTER_MS,
  attentionItemDetail,
  attentionItemReason,
  attentionItemTitle,
  attentionSummaryLine,
  attentionUrgency,
  pendingCountLabel,
} from "./attentionList";

const NOW = new Date("2026-11-07T12:00:00Z").getTime();
const base = { reason: "Pediu desconto", createdAt: NOW - 5 * 60_000 };

describe("attentionItemTitle", () => {
  it("prefere o título do servidor, depois o lead, depois o contato", () => {
    expect(attentionItemTitle({ ...base, title: "  Maria  Souza " })).toBe("Maria Souza");
    expect(attentionItemTitle({ ...base, lead: { title: "Plano anual" } })).toBe("Plano anual");
    expect(attentionItemTitle({ ...base, contact: { firstName: "João", lastName: "Lima" } })).toBe("João Lima");
    expect(attentionItemTitle({ ...base, title: "", lead: null, contact: null })).toBe("Conversa");
  });
});

describe("attentionItemDetail", () => {
  it("usa o resumo da IA em uma linha só", () => {
    expect(attentionItemDetail({ ...base, summary: "Quer\n  10% de\tdesconto" })).toBe("Quer 10% de desconto");
  });

  it("sem resumo, mostra contato e empresa sem repetir o título", () => {
    const h = { ...base, title: "Maria Souza", contact: { firstName: "Maria", lastName: "Souza", company: "Acme" } };
    expect(attentionItemDetail(h)).toBe("Acme");
    expect(attentionItemDetail({ ...h, title: "Plano anual" })).toBe("Maria Souza • Acme");
  });

  it("grupo sem resumo vira Grupo de WhatsApp; sem nada, vazio", () => {
    expect(attentionItemDetail({ ...base, isGroup: true })).toBe("Grupo de WhatsApp");
    expect(attentionItemDetail({ ...base, title: "X" })).toBe("");
  });
});

describe("attentionItemReason", () => {
  it("usa o motivo numa linha só e cai em Pedido de ajuda quando vazio", () => {
    expect(attentionItemReason({ reason: " Pediu\n desconto " })).toBe("Pediu desconto");
    expect(attentionItemReason({ reason: "   " })).toBe("Pedido de ajuda");
    expect(attentionItemReason({ reason: "" })).toBe("Pedido de ajuda");
  });
});

describe("attentionUrgency", () => {
  it("atrasado a partir de uma hora", () => {
    expect(attentionUrgency(NOW - ATTENTION_LATE_AFTER_MS + 1, NOW)).toBe("waiting");
    expect(attentionUrgency(NOW - ATTENTION_LATE_AFTER_MS, NOW)).toBe("late");
  });
});

describe("contagem", () => {
  it("singular e plural", () => {
    expect(pendingCountLabel(1)).toBe("1 pendente");
    expect(pendingCountLabel(52)).toBe("52 pendentes");
  });

  it("resume com o mais antigo quando há dois ou mais", () => {
    expect(attentionSummaryLine([], NOW)).toBe("0 pendentes");
    expect(attentionSummaryLine([{ createdAt: NOW - 60_000 }], NOW)).toBe("1 pendente");
    expect(
      attentionSummaryLine([{ createdAt: NOW - 60_000 }, { createdAt: NOW - 3 * 3600_000 }], NOW)
    ).toBe("2 pendentes · o mais antigo há 3h");
  });

  it("depois de uma semana cita a data", () => {
    const line = attentionSummaryLine([{ createdAt: NOW }, { createdAt: NOW - 10 * 86_400_000 }], NOW);
    expect(line).toMatch(/^2 pendentes · o mais antigo de \d{2} de /);
  });
});
