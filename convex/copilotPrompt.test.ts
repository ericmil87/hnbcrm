/// <reference types="vite/client" />
/**
 * System prompt do Copiloto.
 *
 * Aqui o carimbo de data/hora é SEMPRE ligado: quem fala é o usuário logado, não
 * um agentProfile, e "minhas tarefas de hoje"/"leads parados há 7 dias" dependem
 * de saber que dia é. O bloco fica no FIM, pelo cache de prefixo do provider.
 */
import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "./copilotHttp";

const session = {
  member: { name: "Eric" },
  org: {
    name: "Aos Filhos da Terra",
    currency: "BRL",
    timezone: "America/Sao_Paulo",
    industry: null,
  },
};

// Sexta-feira, 18/09/2026, 14:32 em São Paulo.
const SEXTA_1432_SP = Date.UTC(2026, 8, 18, 17, 32);

describe("buildSystemPrompt (copiloto)", () => {
  test("carimba data e hora no fuso da org, no fim do prompt", () => {
    const prompt = buildSystemPrompt(session, SEXTA_1432_SP);
    expect(prompt).toContain(
      "DATA E HORA ATUAIS: sexta-feira, 18/09/2026, 14:32 (fuso America/Sao_Paulo)."
    );
    expect(prompt).toContain("Próximos dias: sáb 19/09,");
    expect(prompt.trimEnd().endsWith("Nunca chute a data nem invente o dia da semana.")).toBe(true);
    // O resto do prompt continua inteiro, e ANTES do trecho volátil.
    expect(prompt.indexOf("Você é o Copiloto")).toBeLessThan(
      prompt.indexOf("DATA E HORA ATUAIS")
    );
  });

  test("fuso inválido da org não derruba o copiloto", () => {
    const prompt = buildSystemPrompt(
      { ...session, org: { ...session.org, timezone: "America/Sao_Pualo" } },
      SEXTA_1432_SP
    );
    expect(prompt).toContain("(fuso America/Sao_Paulo)");
  });
});
