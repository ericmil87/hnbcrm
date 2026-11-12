import { describe, expect, it } from "vitest";
import { AI_LGPD_ACK_LABEL, AI_LGPD_PARAGRAPHS, aiLgpdPlainText } from "./aiLgpdText";

describe("texto do aceite de IA/LGPD", () => {
  it("é o texto jurídico da tela de IA", () => {
    expect(AI_LGPD_PARAGRAPHS.map(aiLgpdPlainText)).toEqual([
      "Ao ativar, dados de clientes (mensagens, nomes, contexto do CRM) são processados por provedores de IA nos EUA em modo zero-retention (não são retidos nem usados para treino no caminho padrão da plataforma).",
      "Sua organização é a controladora dos dados. Confirme que sua política de privacidade divulga o uso de IA no atendimento e a transferência internacional de dados (LGPD, art. 33).",
    ]);
    expect(AI_LGPD_ACK_LABEL).toBe("Confirmo que minha política de privacidade divulga o uso de IA e a transferência internacional de dados");
  });
});
