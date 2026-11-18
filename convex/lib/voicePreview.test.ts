import { describe, expect, it } from "vitest";
import {
  VOICE_SAMPLE_GREETING,
  VOICE_TEXT_REASON_LABELS,
  voicePreviewCacheKey,
  voicePreviewRateKey,
  voiceSampleText,
  voiceTextReasonLabel,
} from "./voicePreview";
import { VOICE_TEXT_REASONS, planAttendantVoice, voiceNoticeError, voiceTextAfter } from "./tts";

describe("amostra de voz (puro)", () => {
  it("texto da amostra: aviso no início, depois a saudação; sem aviso, só a saudação", () => {
    expect(voiceSampleText(null)).toBe(VOICE_SAMPLE_GREETING);
    expect(voiceSampleText("Sou a assistente do Kenji")).toBe(`Sou a assistente do Kenji. ${VOICE_SAMPLE_GREETING}`);
    expect(voiceSampleText("Sou a assistente do Kenji!")).toBe(`Sou a assistente do Kenji. ${VOICE_SAMPLE_GREETING}`);
  });

  it("chave do cache muda com a voz e com o texto, e é estável", () => {
    const a = voicePreviewCacheKey("Kore", "Oi");
    expect(voicePreviewCacheKey("Kore", "Oi")).toBe(a);
    expect(voicePreviewCacheKey("Puck", "Oi")).not.toBe(a);
    expect(voicePreviewCacheKey("Kore", "Oi.")).not.toBe(a);
    expect(a.length).toBeLessThan(80);
  });

  it("chave da janela tem prefixo próprio (não colide com as do onboarding)", () => {
    expect(voicePreviewRateKey("user", "u1", "1m")).toBe("voice_preview:user:u1:1m");
  });

  it("todo motivo de texto tem rótulo em PT-BR; desconhecido vira genérico", () => {
    for (const r of VOICE_TEXT_REASONS) expect(VOICE_TEXT_REASON_LABELS[r]).toMatch(/\S/);
    expect(voiceTextReasonLabel("motivo_novo")).toBe("Esta resposta iria em texto.");
    expect(voiceTextReasonLabel("motivo_novo")).not.toContain("motivo_novo");
  });
});

describe("regras compartilhadas do aviso e da decisão", () => {
  it("voiceNoticeError: vazio e frase limpa passam; dado e tamanho recusam", () => {
    expect(voiceNoticeError("")).toBeNull();
    expect(voiceNoticeError("Sou a assistente virtual da clínica")).toBeNull();
    expect(voiceNoticeError("Me chame no 11 99999-0000")).toMatch(/números, links/);
    expect(voiceNoticeError("x".repeat(201))).toMatch(/até 200/);
  });

  const base = {
    transport: "bridge",
    isGroup: false,
    lastInboundWasAudio: true,
    draft: false,
    followUp: false,
    hasImage: false,
    notice: null,
    needsDisclosure: false,
    disclosure: "Sou uma IA.",
  };

  it("planAttendantVoice: divulgação entra na fala e também segue por escrito", () => {
    const { plan, disclosureAdded } = planAttendantVoice({ ...base, text: "Oi, tudo bem?", needsDisclosure: true });
    expect(disclosureAdded).toBe(true);
    expect(plan.kind).toBe("voice");
    if (plan.kind !== "voice") return;
    expect(plan.spokenText).toBe("Sou uma IA.\n\nOi, tudo bem?");
    expect(voiceTextAfter(plan.textPart, base.disclosure, disclosureAdded)).toBe("Sou uma IA.");
  });

  it("planAttendantVoice: mesmas regras de planVoiceReply (texto do cliente, dado)", () => {
    expect(planAttendantVoice({ ...base, lastInboundWasAudio: false, text: "Oi" }).plan).toEqual({
      kind: "text",
      reason: "cliente_mandou_texto",
    });
    const { plan } = planAttendantVoice({ ...base, text: "Claro, te explico.\nCusta R$ 90." });
    expect(plan.kind).toBe("voice");
    if (plan.kind === "voice") expect(voiceTextAfter(plan.textPart, base.disclosure, false)).toBe("Custa R$ 90.");
  });

  it("voiceTextAfter: sem dado nem divulgação = null", () => {
    expect(voiceTextAfter(null, "Sou uma IA.", false)).toBeNull();
  });
});
