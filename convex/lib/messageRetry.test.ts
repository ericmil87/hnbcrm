import { describe, expect, test } from "vitest";
import { deliveryRetryInfo, MAX_MANUAL_RETRIES, metadataForRetry, needsDeliveredAck } from "./messageRetry";

const failed = (metadata: Record<string, any> = {}) => ({
  direction: "outbound",
  isInternal: false,
  deliveryStatus: "failed",
  metadata,
});

describe("deliveryRetryInfo", () => {
  test("saída que falhou → pode tentar; recipient_not_found exige checagem", () => {
    expect(deliveryRetryInfo(failed({ deliveryErrorKind: "transient" }))).toMatchObject({
      canRetry: true,
      requiresCheck: false,
      manualRetries: 0,
      maxManualRetries: MAX_MANUAL_RETRIES,
      errorKind: "transient",
      autoRetrying: false,
    });
    expect(deliveryRetryInfo(failed({ deliveryErrorKind: "recipient_not_found" }))?.requiresCheck).toBe(true);
  });
  test("teto de reenvios manuais", () => {
    expect(deliveryRetryInfo(failed({ manualRetries: MAX_MANUAL_RETRIES }))?.canRetry).toBe(false);
    expect(deliveryRetryInfo(failed({ manualRetries: MAX_MANUAL_RETRIES - 1 }))?.canRetry).toBe(true);
  });
  test("retry automático em curso: sem botão, com autoRetrying", () => {
    const info = deliveryRetryInfo({ direction: "outbound", isInternal: false, metadata: { bridgeRetry: { kind: "transient" } } });
    expect(info).toMatchObject({ canRetry: false, autoRetrying: true });
  });
  test("não se aplica a entrada, nota interna, enviada, ainda pendente, ou tradução retida", () => {
    expect(deliveryRetryInfo({ ...failed(), direction: "inbound" })).toBeNull();
    expect(deliveryRetryInfo({ ...failed(), isInternal: true })).toBeNull();
    expect(deliveryRetryInfo({ ...failed(), deliveryStatus: "sent" })).toBeNull();
    expect(deliveryRetryInfo({ direction: "outbound", isInternal: false })).toBeNull();
    expect(deliveryRetryInfo(failed({ translation: { status: "failed", role: "outbound" } }))?.canRetry).toBe(false);
  });
});

test("metadataForRetry zera o erro mas mantém o estado de segurança", () => {
  expect(
    metadataForRetry({
      deliveryError: "x",
      deliveryErrorCode: 1,
      deliveryErrorKind: "transient",
      numberCheck: "unavailable",
      bridgeRetry: {},
      deliveryPreSend: true,
      selfHealAt: 5,
      bridgeAttempts: 3,
      manualRetries: 1,
    })
  ).toEqual({ selfHealAt: 5, bridgeAttempts: 3, manualRetries: 1 });
});

describe("needsDeliveredAck (lista positiva de falhas pré-envio)", () => {
  test("seguras: recipient_not_found, transient, rate_limited, pré-envio explícito, código definitivo da Meta", () => {
    for (const kind of ["recipient_not_found", "transient", "rate_limited"]) expect(needsDeliveredAck({ deliveryErrorKind: kind })).toBe(false);
    expect(needsDeliveredAck({ deliveryErrorKind: "permanent", deliveryPreSend: true })).toBe(false);
    expect(needsDeliveredAck({ deliveryErrorKind: "session", deliveryPreSend: true })).toBe(false);
    expect(needsDeliveredAck({ deliveryError: "Fora da janela (131026)", deliveryErrorCode: 131026, deliveryPreSend: true })).toBe(false);
  });
  test("pedem aceite: ambiguous, permanent/session sem prova, SEM classe (legado/Meta 5xx), textos soltos", () => {
    expect(needsDeliveredAck({ deliveryErrorKind: "ambiguous" })).toBe(true);
    expect(needsDeliveredAck({ deliveryErrorKind: "permanent" })).toBe(true);
    expect(needsDeliveredAck({ deliveryErrorKind: "session" })).toBe(true);
    // código da Meta SOZINHO (genérico, com 5xx) não prova a não-entrega
    expect(needsDeliveredAck({ deliveryError: "x", deliveryErrorCode: 131000 })).toBe(true);
    expect(needsDeliveredAck({})).toBe(true);
    expect(needsDeliveredAck(undefined)).toBe(true);
    expect(needsDeliveredAck({ deliveryError: "Falha no envio pelo bridge: context deadline exceeded" })).toBe(true);
    expect(needsDeliveredAck({ deliveryError: "fetch failed" })).toBe(true);
  });
  test("mensagem de campanha nunca mostra o botão; retry órfão expõe nextAt", () => {
    const base = { direction: "outbound", isInternal: false, deliveryStatus: "failed" };
    expect(deliveryRetryInfo({ ...base, metadata: { campaign: { campaignId: "c" } } })?.canRetry).toBe(false);
    expect(
      deliveryRetryInfo({ direction: "outbound", isInternal: false, metadata: { bridgeRetry: { nextAt: 123 } } })
    ).toMatchObject({ autoRetrying: true, autoRetryNextAt: 123 });
  });
});
