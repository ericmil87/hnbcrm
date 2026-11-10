import { describe, expect, it } from "vitest";
import {
  NOT_ON_WHATSAPP_SEND_PREFIX,
  deliveryFailureView,
  isMarkedNotOnWhatsapp,
  isNotOnWhatsappError,
  retrySuccessText,
  NOT_FOUND_FAILS_BLOCK,
  NOT_FOUND_SEND_ERROR,
  NOT_ON_WHATSAPP_ACK,
  notFoundFailCount,
  notOnWhatsappAckCopy,
  numberWarningOf,
  isBridgeWhatsapp,
} from "./messageDelivery";
import {
  NOT_FOUND_FAILS_BLOCK as SERVER_FAILS_BLOCK,
  NOT_FOUND_SEND_ERROR as SERVER_NOT_FOUND_TEXT,
  NOT_ON_WHATSAPP_SEND_PREFIX as SERVER_PREFIX,
  isMarkedNotOnWhatsapp as serverMarked,
  notFoundFailCount as serverFailCount,
} from "../../convex/lib/whatsappCheck";

const retry = (over = {}) => ({ canRetry: true, manualRetries: 0, maxManualRetries: 3, autoRetrying: false, ...over });

describe("messageDelivery", () => {
  it("prefixo igual ao do servidor", () => {
    expect(NOT_ON_WHATSAPP_SEND_PREFIX).toBe(SERVER_PREFIX);
    expect(isNotOnWhatsappError("Uncaught ConvexError: NOT_ON_WHATSAPP: x")).toBe(true);
    expect(isNotOnWhatsappError("outro erro")).toBe(false);
  });

  it("copy por tipo de erro, texto cru só em detalhes", () => {
    const v = deliveryFailureView(
      { deliveryRetry: retry(), metadata: { deliveryErrorKind: "session", deliveryError: "raw gw" } },
      true
    );
    expect(v?.text).toBe("O WhatsApp deste canal está desconectado.");
    expect(v?.hint).toContain("Reconecte o canal");
    expect(v?.raw).toBe("raw gw");
    expect(v?.showRetry).toBe(true);
    expect(deliveryFailureView({ deliveryRetry: retry(), metadata: { deliveryErrorKind: "transient" } }, true)?.text).toContain("Instabilidade");
    expect(deliveryFailureView({ deliveryRetry: retry(), metadata: { deliveryErrorKind: "rate_limited" } }, true)?.text).toContain("Muitos envios");
  });

  it("número sem WhatsApp: problema de número, sem destaque de reenvio", () => {
    const v = deliveryFailureView(
      { deliveryRetry: retry({ requiresCheck: true }), metadata: { numberCheck: "not_on_whatsapp", deliveryError: "no LID found" } },
      true
    );
    expect(v?.numberProblem).toBe(true);
    expect(v?.text).toBe("Este número não está no WhatsApp.");
    expect(v?.hint).toContain("Confira o número");
    const nf = deliveryFailureView({ deliveryRetry: retry(), metadata: { deliveryErrorKind: "recipient_not_found" } }, true);
    expect(nf?.numberProblem).toBe(true);
  });

  it("checagem indisponível", () => {
    expect(deliveryFailureView({ deliveryRetry: retry(), metadata: { numberCheck: "unavailable" } }, true)?.text).toBe(
      "Não foi possível confirmar o número agora."
    );
  });

  it("reenvio automático: sem botão", () => {
    const v = deliveryFailureView(
      { deliveryRetry: retry({ canRetry: false, autoRetrying: true }), metadata: { bridgeRetry: { lastError: "boom" } } },
      false
    );
    expect(v?.autoRetrying).toBe(true);
    expect(v?.showRetry).toBe(false);
    expect(v?.text).toContain("Reenviando automaticamente");
  });

  it("esgotado: sem botão e diz o motivo", () => {
    const v = deliveryFailureView(
      { deliveryRetry: retry({ canRetry: false, manualRetries: 3 }), metadata: { deliveryErrorKind: "transient" } },
      true
    );
    expect(v?.exhausted).toBe(true);
    expect(v?.showRetry).toBe(false);
    expect(v?.hint).toContain("Limite de reenvios");
  });

  it("tipo desconhecido cai no texto cru; sem nada, null", () => {
    const v = deliveryFailureView({ deliveryRetry: retry(), metadata: { deliveryError: "falha x" } }, true);
    expect(v?.text).toBe("falha x");
    expect(v?.raw).toBeUndefined();
    expect(deliveryFailureView({ metadata: {} }, true)).toBeNull();
    expect(deliveryFailureView({ metadata: { deliveryError: "x" } }, false)).toBeNull();
  });

  it("marcador só vale para o número atual", () => {
    const base = { phone: "+55 11 99999-0000", whatsappCheck: { phone: "5511999990000", status: "not_on_whatsapp" } };
    expect(isMarkedNotOnWhatsapp(base)).toBe(true);
    expect(isMarkedNotOnWhatsapp({ ...base, whatsappNumber: "5511888880000" })).toBe(false);
    expect(isMarkedNotOnWhatsapp({ ...base, whatsappCheck: { phone: "5511999990000", status: "verified" } })).toBe(false);
    expect(isMarkedNotOnWhatsapp(null)).toBe(false);
  });

  it("toast de sucesso", () => {
    expect(retrySuccessText(true)).toContain("corrigido");
    expect(retrySuccessText(false)).toBe("Mensagem reenviada");
  });

  it("falha ambígua: pode ter chegado, pede aceite", () => {
    const v = deliveryFailureView(
      { deliveryRetry: retry({ requiresDeliveredAck: true }), metadata: { deliveryErrorKind: "ambiguous", deliveryError: "timeout" } },
      true
    );
    expect(v?.text).toBe("Não sabemos se esta mensagem chegou ao cliente.");
    expect(v?.hint).toContain("antes de reenviar");
    expect(v?.requiresDeliveredAck).toBe(true);
    expect(v?.raw).toBe("timeout");
  });

  it("checagem inconclusiva não afirma que não tem WhatsApp", () => {
    const v = deliveryFailureView(
      { deliveryRetry: retry({ requiresCheck: true }), metadata: { numberCheck: "inconclusive", deliveryErrorKind: "recipient_not_found" } },
      true
    );
    expect(v?.text).toBe("Não foi possível confirmar o número agora.");
    expect(v?.hint).toContain("não quer dizer que ele não tenha WhatsApp");
    expect(v?.numberProblem).toBe(false);
  });

  it("espera entre checagens: só enquanto retryAfter está no futuro", () => {
    const input = {
      deliveryRetry: retry({ requiresCheck: true, retryAfter: 2000, numberChecks: 1, maxNumberChecks: 3 }),
      metadata: { deliveryErrorKind: "recipient_not_found" },
    };
    expect(deliveryFailureView(input, true, 1000)?.waitUntil).toBe(2000);
    expect(deliveryFailureView(input, true, 2000)?.waitUntil).toBeUndefined();
    expect(deliveryFailureView(input, true, 3000)?.showRetry).toBe(true);
  });

  it("teto de checagens: sem botão, aponta o número", () => {
    const v = deliveryFailureView(
      {
        deliveryRetry: retry({ canRetry: false, requiresCheck: true, numberChecks: 3, maxNumberChecks: 3 }),
        metadata: { deliveryErrorKind: "recipient_not_found" },
      },
      true
    );
    expect(v?.checksExhausted).toBe(true);
    expect(v?.showRetry).toBe(false);
    expect(v?.hint).toContain("Confira o número do contato");
  });

  it("espera vale para qualquer falha com retryAfter futuro", () => {
    const v = deliveryFailureView(
      { deliveryRetry: retry({ retryAfter: 5000 }), metadata: { deliveryErrorKind: "transient" } },
      true,
      1000
    );
    expect(v?.waitUntil).toBe(5000);
    expect(v?.nextChangeAt).toBe(5000);
  });

  it("esgotado: dica depende da causa", () => {
    const ex = (meta: Record<string, unknown>) =>
      deliveryFailureView({ deliveryRetry: retry({ canRetry: false, manualRetries: 3 }), metadata: meta }, true)?.hint;
    expect(ex({ deliveryErrorKind: "recipient_not_found" })).toContain("Confira o número do contato");
    expect(ex({ deliveryErrorKind: "session" })).toContain("Reconecte o canal");
    expect(ex({ deliveryErrorKind: "session" })).not.toContain("número do contato");
    expect(ex({ deliveryErrorKind: "transient" })).toBe("Limite de reenvios atingido. Escreva uma nova mensagem.");
  });

  it("falha sem classe que pede aceite: aviso coerente com o diálogo", () => {
    const v = deliveryFailureView(
      { deliveryRetry: retry({ requiresDeliveredAck: true }), metadata: { deliveryError: "falha estranha" } },
      true
    );
    expect(v?.text).toBe("falha estranha");
    expect(v?.hint).toContain("antes de reenviar");
    expect(v?.requiresDeliveredAck).toBe(true);
  });

  it("campanha: sem botão e com a dica da tela da campanha", () => {
    const v = deliveryFailureView(
      { deliveryRetry: retry({ canRetry: false }), metadata: { campaign: { id: "c1" }, deliveryErrorKind: "transient" } },
      true
    );
    expect(v?.showRetry).toBe(false);
    expect(v?.note).toBe("Mensagem de campanha: o reenvio é feito na tela da campanha.");
  });

  it("opt_out: sem botão", () => {
    const v = deliveryFailureView({ deliveryRetry: retry(), metadata: { numberCheck: "opt_out" } }, true);
    expect(v?.text).toBe("Este contato pediu para não receber mensagens.");
    expect(v?.showRetry).toBe(false);
  });

  it("reenvio automático vencido (30 min) deixa de dizer 'Reenviando'", () => {
    const input = { deliveryRetry: retry({ canRetry: false, autoRetrying: true, autoRetryNextAt: 1000 }), metadata: {} };
    const fresh = deliveryFailureView(input, false, 1000 + 29 * 60_000);
    expect(fresh?.text).toBe("Reenviando automaticamente…");
    expect(fresh?.nextChangeAt).toBe(1000 + 30 * 60_000);
    const stale = deliveryFailureView(input, false, 1000 + 31 * 60_000);
    expect(stale?.text).toBe("O reenvio automático não foi concluído.");
    expect(stale?.autoRetrying).toBe(false);
    expect(stale?.showRetry).toBe(false);
  });

  it("constantes espelham o servidor", () => {
    expect(NOT_FOUND_FAILS_BLOCK).toBe(SERVER_FAILS_BLOCK);
    expect(NOT_FOUND_SEND_ERROR).toBe(SERVER_NOT_FOUND_TEXT);
  });

  it("marcador (duas grafias BR) e contador (dígitos exatos) concordam com o servidor", () => {
    const with9 = "5511987654321";
    const without9 = "551187654321";
    const numbers = [with9, without9, "5511999990000", "5521987654321"];
    for (const stored of [with9, without9]) {
      for (const current of numbers) {
        for (const field of ["phone", "whatsappNumber"] as const) {
          const contact: any = {
            [field]: current,
            whatsappCheck: { phone: stored, status: "not_on_whatsapp", checkedAt: 1 },
            whatsappFails: { phone: stored, count: 3, at: 1 },
          };
          expect(isMarkedNotOnWhatsapp(contact)).toBe(serverMarked(contact));
          expect(notFoundFailCount(contact)).toBe(serverFailCount(contact));
        }
      }
    }
    expect(isMarkedNotOnWhatsapp({ phone: with9, whatsappCheck: { phone: without9, status: "not_on_whatsapp" } })).toBe(true);
    // contador: exato — a outra grafia não conta
    expect(notFoundFailCount({ phone: with9, whatsappFails: { phone: without9, count: 3 } })).toBe(0);
    expect(notFoundFailCount({ phone: with9, whatsappFails: { phone: with9, count: 3 } })).toBe(3);
  });

  it("aviso por falhas seguidas: só a partir do 2º, e sem afirmar que não há conta", () => {
    const c = (count: number) => ({ phone: "5511987654321", whatsappFails: { phone: "5511987654321", count } });
    expect(numberWarningOf(c(1))).toBeNull();
    expect(numberWarningOf(c(2))).toBe("not_found");
    expect(numberWarningOf({ ...c(5), whatsappNumber: "5521987654321" })).toBeNull();
    expect(numberWarningOf({ ...c(2), whatsappCheck: { phone: "5511987654321", status: "not_on_whatsapp" } })).toBe(
      "not_on_whatsapp"
    );
  });

  it("corpo do diálogo segue o texto do servidor", () => {
    expect(notOnWhatsappAckCopy(`NOT_ON_WHATSAPP: ${SERVER_NOT_FOUND_TEXT}`).title).toBe("O WhatsApp não encontrou este número");
    expect(notOnWhatsappAckCopy(`NOT_ON_WHATSAPP: ${SERVER_NOT_FOUND_TEXT}`).description).not.toContain("não tem conta");
    expect(notOnWhatsappAckCopy("NOT_ON_WHATSAPP: Este número não está no WhatsApp ...")).toBe(NOT_ON_WHATSAPP_ACK);
    expect(notOnWhatsappAckCopy(null)).toBe(NOT_ON_WHATSAPP_ACK);
  });

  it("aviso do número só no WhatsApp pelo bridge", () => {
    expect(isBridgeWhatsapp("whatsapp", "bridge")).toBe(true);
    expect(isBridgeWhatsapp("whatsapp", "meta")).toBe(false);
    expect(isBridgeWhatsapp("whatsapp", undefined)).toBe(false);
    expect(isBridgeWhatsapp("instagram", "bridge")).toBe(false);
    expect(isBridgeWhatsapp("messenger", null)).toBe(false);
  });
});
