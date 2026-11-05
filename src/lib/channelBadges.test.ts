import { describe, expect, it } from "vitest";
import { bridgeStateBadge, statusBadgeVariant, statusLabel, type BridgeSessionState } from "./channelBadges";

describe("channelBadges", () => {
  it("mapeia o status do canal", () => {
    expect(statusBadgeVariant("active")).toBe("success");
    expect(statusBadgeVariant("error")).toBe("error");
    expect(statusBadgeVariant("disabled")).toBe("default");
    expect(statusLabel("active")).toBe("Ativo");
    expect(statusLabel("error")).toBe("Erro");
    expect(statusLabel("disabled")).toBe("Desativado");
  });

  it("mapeia cada estado de conexão do WhatsApp por QR code", () => {
    const cases: Array<[BridgeSessionState, string, string]> = [
      ["connected", "success", "Conectado"],
      ["connecting", "warning", "Reconectando"],
      ["qr", "info", "Aguardando QR"],
      ["banned", "error", "Banido"],
      ["temporarily_banned", "error", "Banimento temporário"],
      ["outdated", "error", "Conexão desatualizada"],
      ["logged_out", "error", "Deslogado"],
      ["disconnected", "error", "Deslogado"],
    ];
    for (const [state, variant, label] of cases) {
      expect(bridgeStateBadge(state)).toEqual({ variant, label });
    }
  });
});
