import { describe, expect, test } from "vitest";
import { buildSetupContextBlock, type SetupContextInput } from "./onboardingSetupContext";

const base: SetupContextInput = {
  organizationName: "Clínica Sol",
  timezone: "America/Sao_Paulo",
  segment: "saude",
  business: { displayName: "Clínica Sol", offer: "Consultas", audience: "Famílias", tone: "acolhedor", region: "Recife" },
  steps: { business: "done", funnel: "done", whatsapp: "pending", attendant: "skipped", test: "pending" },
  nextStep: "whatsapp",
  capabilities: { managedBridge: true, transcription: false, llm: true, metaMessaging: false },
  whatsappConnected: true,
  attendant: { name: "Sol", mode: "suggest" },
};

describe("buildSetupContextBlock", () => {
  test("contextBlock mascara telefone", () => {
    const out = buildSetupContextBlock({
      ...base,
      business: { ...base.business, offer: "Ligue 81 99876-5432 ou +55 (81) 3333-4444" },
      // @ts-expect-error entrada suja: telefone completo vindo de fora do shape
      whatsappPhone: "5581998765432",
    });
    expect(out).toContain("conectado");
    expect(out).not.toMatch(/\d{8,}/);
    expect(out).not.toMatch(/\d{4,5}-\d{4}/);
  });

  test("contextBlock lista passos pendentes", () => {
    const out = buildSetupContextBlock(base);
    expect(out).toContain("Passos pendentes: WhatsApp, Teste da IA, Extras (áudio e imagem), Equipe.");
    expect(out).toContain("Passos feitos: Seu negócio, Funil de vendas.");
    expect(out).toContain("Passos pulados: Atendente de IA.");
    expect(out).toContain("modo Sugerir");
    expect(out).toContain("no máximo 5 perguntas");
  });

  test("contextBlock não contém e-mail nem id", () => {
    const out = buildSetupContextBlock({
      ...base,
      business: { ...base.business, offer: "Escreva para contato@clinica.com.br" },
    });
    expect(out).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(out).not.toMatch(/\d{8,}/);
    expect(out).not.toMatch(/\b[a-z0-9]{32}\b/);
  });
});
