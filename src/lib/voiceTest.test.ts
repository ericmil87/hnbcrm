import { describe, expect, it } from "vitest";
import { previewNotice, simulatedVoiceView, simulatorTransportArg } from "./voiceTest";

describe("simulatorTransportArg", () => {
  it("com voz: WhatsApp por QR code por padrão; com Meta, respeita a escolha", () => {
    expect(simulatorTransportArg({ voiceOn: true, metaEnabled: false, transport: "meta" })).toBe("bridge");
    expect(simulatorTransportArg({ voiceOn: true, metaEnabled: true, transport: "instagram" })).toBe("instagram");
    expect(simulatorTransportArg({ voiceOn: true, metaEnabled: true, transport: "bridge" })).toBe("bridge");
  });
  it("sem voz: como antes (só manda canal quando há Meta e não é o padrão)", () => {
    expect(simulatorTransportArg({ voiceOn: false, metaEnabled: false, transport: "bridge" })).toBeUndefined();
    expect(simulatorTransportArg({ voiceOn: false, metaEnabled: true, transport: "meta" })).toBeUndefined();
    expect(simulatorTransportArg({ voiceOn: false, metaEnabled: true, transport: "messenger" })).toBe("messenger");
  });
});

describe("simulatedVoiceView", () => {
  const audio = {
    mode: "audio" as const,
    url: "https://x.example/a.wav",
    durationSec: 2.4,
    spokenText: "Oi",
    textAfter: null,
    voice: "Kore",
    noticeIncluded: false,
    enabledInOrg: true,
    cached: false,
  };
  it("áudio: título com voz e duração; aviso quando a voz está desligada", () => {
    expect(simulatedVoiceView(audio)).toEqual({ tone: "audio", title: "Resposta em áudio · voz Kore · 2 s", detail: null, warning: null });
    const off = simulatedVoiceView({ ...audio, enabledInOrg: false, noticeIncluded: true });
    expect(off.warning).toMatch(/desligada/);
    expect(off.detail).toMatch(/aviso de voz sintética/);
  });
  it("texto pela regra × falha do teste", () => {
    expect(simulatedVoiceView({ mode: "text", rule: true, reason: "longo", message: "Longa demais.", enabledInOrg: true })).toMatchObject({
      tone: "text",
      title: "Esta resposta iria em texto",
      detail: "Longa demais.",
    });
    expect(simulatedVoiceView({ mode: "text", rule: false, reason: "falha_tts", message: "Falhou.", enabledInOrg: true }).tone).toBe("error");
  });
});

describe("previewNotice", () => {
  it("normaliza espaços; vazio vira undefined", () => {
    expect(previewNotice("  Sou   a IA ")).toBe("Sou a IA");
    expect(previewNotice("   ")).toBeUndefined();
  });
});
