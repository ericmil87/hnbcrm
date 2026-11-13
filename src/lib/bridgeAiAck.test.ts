import { describe, expect, it } from "vitest";
import { asksAiAckOnQrConnect, bridgeAiState, BRIDGE_AI_STATE_TEXT } from "./bridgeAiAck";

const base = { active: true, attendantEnabled: true, hasAttendant: true, hasConnectedBridgeChannel: true, bridgeAiAckDone: false };

describe("bridgeAiState", () => {
  it("aceite dado = ligado", () => {
    expect(bridgeAiState({ ...base, bridgeAiAckDone: true })).toBe("on");
    expect(BRIDGE_AI_STATE_TEXT.on).toMatch(/^Ligado/);
  });

  it("muda só com número por QR code conectado, IA e atendente ligados e sem aceite", () => {
    expect(bridgeAiState(base)).toBe("muted");
    expect(bridgeAiState({ ...base, hasConnectedBridgeChannel: false })).toBe("off");
    expect(bridgeAiState({ ...base, hasConnectedBridgeChannel: undefined })).toBe("off");
    expect(bridgeAiState({ ...base, active: false })).toBe("off");
    expect(bridgeAiState({ ...base, attendantEnabled: false })).toBe("off");
    expect(bridgeAiState({ ...base, hasAttendant: false })).toBe("off");
    expect(BRIDGE_AI_STATE_TEXT.off).toBe("Desligado: a IA só responde no WhatsApp oficial (Meta).");
  });
});

describe("asksAiAckOnQrConnect", () => {
  it("pede junto com o aviso de banimento só com a IA ligada e sem aceite", () => {
    expect(asksAiAckOnQrConnect(base)).toBe(true);
    expect(asksAiAckOnQrConnect({ ...base, bridgeAiAckDone: true })).toBe(false);
    expect(asksAiAckOnQrConnect({ ...base, active: false })).toBe(false);
    expect(asksAiAckOnQrConnect({ ...base, attendantEnabled: false })).toBe(false);
  });
});
