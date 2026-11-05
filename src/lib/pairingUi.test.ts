import { describe, expect, it } from "vitest";
import {
  CODE_POLL_MAX_MS,
  canRequestNewCode,
  codePollExpired,
  defaultConnectMode,
  formatLinkingCode,
  friendlyPairingError,
} from "./pairingUi";

describe("pairingUi", () => {
  it("celular usa código por padrão", () => {
    expect(defaultConnectMode(true)).toBe("code");
    expect(defaultConnectMode(false)).toBe("qr");
  });

  it("formata código de 8 caracteres", () => {
    expect(formatLinkingCode("abcd1234")).toBe("ABCD-1234");
    expect(formatLinkingCode("ABCD-1234")).toBe("ABCD-1234");
    expect(formatLinkingCode("abc")).toBe("ABC");
  });

  it("oferece novo código após 150 s", () => {
    expect(canRequestNewCode(149_999)).toBe(false);
    expect(canRequestNewCode(150_000)).toBe(true);
  });

  it("para de consultar após 3 minutos", () => {
    expect(codePollExpired(CODE_POLL_MAX_MS - 1)).toBe(false);
    expect(codePollExpired(CODE_POLL_MAX_MS)).toBe(true);
  });

  it("esconde termos técnicos do erro", () => {
    expect(friendlyPairingError("bridge timeout")).toMatch(/Não foi possível/);
    expect(friendlyPairingError("Número inválido")).toBe("Número inválido");
  });
});
