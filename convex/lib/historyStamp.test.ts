import { describe, expect, it } from "vitest";
import { historyStamp } from "./historyStamp";
import { buildGroupSummarySystemPrompt, buildGroupSystemPrompt } from "./groupAgentCore";
import { buildConversationContextBlock } from "./telegramContext";

const DAY = 24 * 60 * 60 * 1000;
/** Segunda 23/11/2026 12:25 em São Paulo. */
const NOW = Date.UTC(2026, 10, 23, 15, 25);
/** Domingo 22/11 22:29 em São Paulo (01:29 UTC de segunda). */
const DOM_2229 = Date.UTC(2026, 10, 23, 1, 29);

describe("historyStamp", () => {
  it("sem ano para mensagem recente do mesmo ano", () => {
    expect(historyStamp(DOM_2229, "America/Sao_Paulo", NOW)).toBe("dom 22/11 22:29");
  });

  it("respeita o fuso (mesmo instante, outro dia/hora)", () => {
    expect(historyStamp(DOM_2229, "Europe/Lisbon", NOW)).toBe("seg 23/11 01:29");
    expect(historyStamp(DOM_2229, "America/Manaus", NOW)).toBe("dom 22/11 21:29");
  });

  it("acrescenta o ano quando é de outro ano", () => {
    const dezembro = Date.UTC(2025, 11, 30, 15, 0);
    expect(historyStamp(dezembro, "America/Sao_Paulo", NOW)).toMatch(/ 2025$/);
  });

  it("acrescenta o ano quando tem mais de 180 dias, mesmo no mesmo ano", () => {
    const agora = Date.UTC(2026, 10, 23, 15, 25);
    const velha = agora - 200 * DAY; // abril de 2026
    expect(historyStamp(velha, "America/Sao_Paulo", agora)).toMatch(/ 2026$/);
    expect(historyStamp(agora - 100 * DAY, "America/Sao_Paulo", agora)).not.toMatch(/2026$/);
  });

  it("a virada de ano conta no fuso LOCAL: 31/12 22:00 em SP lida em janeiro mostra o ano anterior", () => {
    const trintaEUm2200 = Date.UTC(2026, 0, 1, 1, 0); // 31/12/2025 22:00 em SP (já é 2026 em UTC)
    const lidaEmJaneiro = Date.UTC(2026, 0, 2, 15, 0);
    expect(historyStamp(trintaEUm2200, "America/Sao_Paulo", lidaEmJaneiro)).toBe("qua 31/12 22:00 2025");
    // Mesmo ano local (leitura em 31/12 à noite, em SP, já 01/01 em UTC): sem ano.
    const lidaMesmaNoite = Date.UTC(2026, 0, 1, 1, 30);
    expect(historyStamp(trintaEUm2200, "America/Sao_Paulo", lidaMesmaNoite)).toBe("qua 31/12 22:00");
  });

  it("sem `now` nunca acrescenta o ano; fuso inválido não lança", () => {
    expect(historyStamp(DOM_2229, "America/Sao_Paulo")).toBe("dom 22/11 22:29");
    expect(() => historyStamp(DOM_2229, "Nao/Existe", NOW)).not.toThrow();
  });
});

describe("prompts de grupo", () => {
  const base = {
    agentName: "Guia",
    orgName: "Org",
    language: "pt-BR",
    persona: null,
    knowledge: null,
    groupSubject: "Sala",
    participantsCount: 3,
    extraInstructions: null,
  };

  it("notas da equipe: com fuso levam a data; sem fuso saem como antes", () => {
    const notes = [{ text: "amanhã às 10h", at: DOM_2229 }];
    const dated = buildGroupSystemPrompt({
      ...base,
      teamNotes: notes,
      timezone: "America/Sao_Paulo",
      now: NOW,
    });
    expect(dated).toContain("- [dom 22/11 22:29] amanhã às 10h");
    const plain = buildGroupSystemPrompt({ ...base, teamNotes: notes });
    expect(plain).toContain("- amanhã às 10h");
    expect(plain).not.toContain("[dom");
  });

  it("resumo: bloco no fim, regra de data real, e sem bloco quando null", () => {
    const withBlock = buildGroupSummarySystemPrompt({
      orgName: "Org",
      language: "pt-BR",
      groupSubject: "Sala",
      hours: 24,
      messageCount: 3,
      dateTimeBlock: "DATA E HORA ATUAIS: X",
    });
    expect(withBlock.endsWith("DATA E HORA ATUAIS: X")).toBe(true);
    expect(withBlock).toContain("use a data real");
    const without = buildGroupSummarySystemPrompt({
      orgName: "Org",
      language: "pt-BR",
      groupSubject: "Sala",
      hours: 24,
      messageCount: 3,
      dateTimeBlock: null,
    });
    expect(without).not.toContain("DATA E HORA");
  });
});

describe("contexto do Copiloto no Telegram", () => {
  it("22:29 em São Paulo NÃO vira o dia seguinte (antes: ISO em UTC)", () => {
    const block = buildConversationContextBlock({
      channel: "whatsapp",
      teamNotes: [],
      messages: [{ direction: "inbound", author: "Maria", at: DOM_2229, text: "amanhã às 10h está bom" }],
      discreet: false,
      currency: "BRL",
      timezone: "America/Sao_Paulo",
    });
    expect(block).toContain("dom 22/11 22:29");
    expect(block).not.toContain("2026-11-23T"); // ISO UTC da mesma mensagem
    expect(block).not.toMatch(/\d{12,}/);
  });
});
