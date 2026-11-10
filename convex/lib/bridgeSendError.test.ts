import { describe, expect, test } from "vitest";
import {
  BRIDGE_MAX_SEND_ATTEMPTS,
  BRIDGE_RATE_LIMIT_DELAY_MS,
  BRIDGE_TRANSIENT_DELAYS_MS,
  bridgeRetryPlan,
  classifyBridgeSendError,
  isPreSendHttpRejection,
} from "./bridgeSendError";

describe("classifyBridgeSendError", () => {
  test("no LID found (texto real do whatsmeow) → recipient_not_found", () => {
    expect(
      classifyBridgeSendError({
        error: "error sending message: no LID found for 5531990001234@s.whatsapp.net from server",
        status: 500,
      })
    ).toBe("recipient_not_found");
  });

  test("falha do lookup (usync) → transient, não recipient_not_found", () => {
    expect(
      classifyBridgeSendError({
        error: "failed to get user info for [5531990001234@s.whatsapp.net] to fill LID cache: info query timed out",
        status: 500,
      })
    ).toBe("transient");
    expect(
      classifyBridgeSendError({ error: "failed to get user info for [x@s.whatsapp.net] to fill LID cache: websocket disconnected" })
    ).toBe("transient");
  });

  test("429 rate-overlimit (também dentro do lookup) → rate_limited", () => {
    expect(classifyBridgeSendError({ error: "info query returned status 429: rate-overlimit", status: 500 })).toBe("rate_limited");
    expect(
      classifyBridgeSendError({ error: "failed to get user info for [x] to fill LID cache: 429: rate-overlimit" })
    ).toBe("rate_limited");
    expect(classifyBridgeSendError({ error: "", status: 429 })).toBe("rate_limited");
  });

  test("falha local do store de LID → transient", () => {
    expect(classifyBridgeSendError({ error: "failed to get LID for PN 5531990001234@s.whatsapp.net: db locked" })).toBe("transient");
  });

  test("sessão: sem sessão / deslogado / não conectado → session", () => {
    for (const error of ["no session", "session not connected", "client is logged out", "not logged in", "Unauthorized"]) {
      expect(classifyBridgeSendError({ error, status: 400 })).toBe("session");
    }
    expect(classifyBridgeSendError({ error: "x", status: 401 })).toBe("session");
    expect(classifyBridgeSendError({ error: "x", status: 403 })).toBe("session");
  });

  test("conexão recusada / DNS (antes de qualquer envio) → transient", () => {
    expect(classifyBridgeSendError({ error: "connect ECONNREFUSED 10.0.0.1:8080", network: true })).toBe("transient");
    expect(classifyBridgeSendError({ error: "getaddrinfo ENOTFOUND wuzapi.example.com", network: true })).toBe("transient");
  });

  test("pode ter sido enviado (timeout, EOF, reset, 5xx, 200 sem id) → ambiguous, nunca transient", () => {
    expect(classifyBridgeSendError({ error: "timed out waiting for message send response", status: 500 })).toBe("ambiguous");
    expect(classifyBridgeSendError({ error: "The operation was aborted due to timeout", network: true })).toBe("ambiguous");
    expect(classifyBridgeSendError({ error: "unexpected EOF", network: true })).toBe("ambiguous");
    expect(classifyBridgeSendError({ error: "read: connection reset by peer", network: true })).toBe("ambiguous");
    expect(classifyBridgeSendError({ error: "Falha no envio (HTTP 504)", status: 504 })).toBe("ambiguous");
    expect(classifyBridgeSendError({ error: "", status: 503 })).toBe("ambiguous");
    expect(classifyBridgeSendError({ error: "Gateway não retornou o id da mensagem", status: 200 })).toBe("ambiguous");
    expect(classifyBridgeSendError({ error: "Falha inesperada no envio: x" })).toBe("ambiguous");
    expect(classifyBridgeSendError({ error: "boom", network: true })).toBe("ambiguous");
  });

  test("B1: 2xx sem id reconhecido, desconexão DEPOIS do envio e network:true → ambiguous, nunca session/permanent", () => {
    // 200 com o id numa grafia que o parser não lê: o texto vira "Sent"
    expect(classifyBridgeSendError({ error: "Sent", status: 200 })).toBe("ambiguous");
    expect(classifyBridgeSendError({ error: "algo totalmente novo", status: 200 })).toBe("ambiguous");
    expect(classifyBridgeSendError({ error: "websocket disconnected before message send returned response", status: 500 })).toBe("ambiguous");
    // 5xx com texto de sessão: não prova que foi antes do envio
    expect(classifyBridgeSendError({ error: "no session", status: 500 })).toBe("ambiguous");
    expect(classifyBridgeSendError({ error: "session not connected", status: 502 })).toBe("ambiguous");
    expect(classifyBridgeSendError({ error: "Client network socket disconnected before secure TLS connection", network: true })).toBe("ambiguous");
    expect(classifyBridgeSendError({ error: "invalid response body", network: true })).toBe("ambiguous");
    expect(classifyBridgeSendError({ error: "context deadline exceeded" })).toBe("ambiguous");
    expect(classifyBridgeSendError({ error: "fetch failed", network: true })).toBe("ambiguous");
    // recusa/DNS continuam seguros
    expect(classifyBridgeSendError({ error: "connect ECONNREFUSED", network: true })).toBe("transient");
  });

  test("isPreSendHttpRejection: só 4xx (exceto 408)", () => {
    expect(isPreSendHttpRejection(400)).toBe(true);
    expect(isPreSendHttpRejection(401)).toBe(true);
    expect(isPreSendHttpRejection(408)).toBe(false);
    expect(isPreSendHttpRejection(500)).toBe(false);
    expect(isPreSendHttpRejection(200)).toBe(false);
    expect(isPreSendHttpRejection(undefined)).toBe(false);
  });

  test("payload inválido (400) e qualquer desconhecido → permanent (nunca retry)", () => {
    expect(classifyBridgeSendError({ error: "could not decode payload: invalid Phone", status: 400 })).toBe("permanent");
    expect(classifyBridgeSendError({ error: "Phone is required", status: 400 })).toBe("permanent");
    expect(classifyBridgeSendError({ error: "algo totalmente novo", status: 418 })).toBe("permanent");
    expect(classifyBridgeSendError({})).toBe("permanent");
  });

  test("5xx com texto permanente conhecido continua permanent", () => {
    expect(classifyBridgeSendError({ error: "invalid media type", status: 500 })).toBe("permanent");
  });
});

describe("bridgeRetryPlan", () => {
  test("transient: 3 envios no total, atraso crescente", () => {
    expect(BRIDGE_MAX_SEND_ATTEMPTS).toBe(3);
    expect(bridgeRetryPlan("transient", 1, false)).toEqual({ retry: true, delayMs: BRIDGE_TRANSIENT_DELAYS_MS[0] });
    expect(bridgeRetryPlan("transient", 2, false)).toEqual({ retry: true, delayMs: BRIDGE_TRANSIENT_DELAYS_MS[1] });
    expect(BRIDGE_TRANSIENT_DELAYS_MS[1]).toBeGreaterThan(BRIDGE_TRANSIENT_DELAYS_MS[0]);
    expect(bridgeRetryPlan("transient", 3, false)).toEqual({ retry: false });
  });

  test("rate_limited: no máximo UM retry, depois de um atraso longo", () => {
    expect(bridgeRetryPlan("rate_limited", 1, false)).toEqual({ retry: true, delayMs: BRIDGE_RATE_LIMIT_DELAY_MS });
    expect(bridgeRetryPlan("rate_limited", 2, true)).toEqual({ retry: false });
    expect(BRIDGE_RATE_LIMIT_DELAY_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });

  test("session, permanent, ambiguous e recipient_not_found nunca reenviam sozinhos", () => {
    for (const kind of ["session", "permanent", "recipient_not_found", "ambiguous"] as const) {
      expect(bridgeRetryPlan(kind, 1, false)).toEqual({ retry: false });
    }
  });
});
