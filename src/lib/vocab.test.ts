import { describe, expect, it } from "vitest";
import { BANNED_UI_TERMS, VOCAB, findBannedTerm, vocabLabels } from "./vocab";
import { sentenceCaseViolations } from "./uiStrings";

// Rótulos que são nomes próprios compostos ou frases com maiúsculas legítimas.
const labels = vocabLabels();

describe("VOCAB", () => {
  it("tem rótulos", () => {
    expect(labels.length).toBeGreaterThan(60);
  });

  it("nenhum rótulo usa um termo banido", () => {
    for (const label of labels) {
      expect(findBannedTerm(label), label).toBeNull();
    }
  });

  it("todo rótulo está em sentence case", () => {
    for (const label of labels) {
      expect(sentenceCaseViolations(label), label).toEqual([]);
    }
  });

  it("não tem reticências de três pontos nem rótulos vazios", () => {
    for (const label of labels) {
      expect(label.trim()).toBe(label);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toContain("...");
    }
  });

  it("nomes principais do glossário", () => {
    expect(VOCAB.conversations.nav).toBe("Conversas");
    expect(VOCAB.attention.nav).toBe("Requer atenção");
    expect(VOCAB.funnel.nav).toBe("Funil");
    expect(VOCAB.audit.nav).toBe("Histórico de alterações");
    expect(VOCAB.reports.nav).toBe("Relatórios");
    expect(VOCAB.agenda.nav).toBe("Agenda");
    expect(VOCAB.attendant.modeAuto).toBe("Responder sozinha");
  });
});

describe("BANNED_UI_TERMS", () => {
  it("pega os termos antigos e sugere o novo", () => {
    expect(findBannedTerm("Fila de Repasses")?.use).toContain("Requer atenção");
    expect(findBannedTerm("Nova Pipeline")?.use).toBe("Funil");
    expect(findBannedTerm("Código de pareamento")?.use).toBe("código de conexão");
    expect(findBannedTerm("Atendente virtual")?.use).toBe("Atendente IA");
    expect(findBannedTerm("Cloud API")?.use).toBe("WhatsApp oficial (Meta)");
  });

  it("não pega as formas corretas", () => {
    for (const ok of ["Requer atenção", "Funil de vendas", "E-mail", "Etiquetas", "Responder sozinha"]) {
      expect(findBannedTerm(ok), ok).toBeNull();
    }
  });

  it("todo padrão tem sugestão", () => {
    for (const t of BANNED_UI_TERMS) expect(t.use.length).toBeGreaterThan(0);
  });
});
