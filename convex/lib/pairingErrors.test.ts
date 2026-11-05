import { describe, expect, test } from "vitest";
import { friendlyPairingError, PAIRING_ERROR_COPY } from "./pairingErrors";

describe("friendlyPairingError", () => {
  test.each([
    ["sem_telefone", "invalidNumber"],
    ["invalid phone number", "invalidNumber"],
    ["HTTP 429", "rateLimited"],
    ["HTTP 502", "unreachable"],
    ["fetch failed", "unreachable"],
    ["Configuração bridge incompleta — reconfigure o canal", "incomplete"],
    ["algo estranho do gateway Go: panic at 0x1", "unreachable"],
    ["xyz", "unknown"],
    [undefined, "unknown"],
  ] as const)("%s", (raw, key) => {
    expect(friendlyPairingError(raw)).toBe(PAIRING_ERROR_COPY[key]);
  });

  test("nunca devolve o detalhe cru", () => {
    for (const raw of ["HTTP 500 token=abc123", "ECONNREFUSED 10.0.0.1:8080", "xyz secret"]) {
      const out = friendlyPairingError(raw);
      expect(out).not.toMatch(/abc123|10\.0\.0\.1|secret|HTTP/);
    }
  });
});
