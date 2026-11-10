import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageBubble } from "./MessageBubble";
import type { InboxMessage } from "./types";
import { LONG_PRESS_MS } from "@/lib/longPress";

const AT = new Date(2026, 10, 6, 14, 5).getTime();
const msg = (over: Partial<InboxMessage> & { senderId?: string }): InboxMessage =>
  ({
    _id: "m1",
    conversationId: "c1",
    content: "Oi, tudo bem?",
    direction: "inbound",
    senderType: "contact",
    isInternal: false,
    createdAt: AT,
    ...over,
  }) as InboxMessage;

const noop = () => {};
const handlers = {
  onReply: noop,
  onReact: noop,
  onForward: noop,
  onTranscribe: noop,
  onDescribeImage: noop,
  onJumpToMessage: noop,
};

describe("MessageBubble (estilo WhatsApp)", () => {
  it("1 a 1: recebida e a minha sem rótulo; hora HH:MM sem 'Hoje'", () => {
    const { container, rerender } = render(
      <MessageBubble message={msg({})} channel="whatsapp" canInteract currentMemberId="me" contactName="Ana" {...handlers} />
    );
    expect(screen.queryByText("Ana")).toBeNull();
    const time = container.querySelector("time");
    expect(time?.textContent).toMatch(/^\d{2}:\d{2}$/);
    rerender(
      <MessageBubble
        message={msg({ direction: "outbound", senderType: "user", senderId: "me", sender: { name: "eric@milfont.net" } })}
        channel="whatsapp"
        canInteract
        currentMemberId="me"
        {...handlers}
      />
    );
    expect(screen.queryByText("eric@milfont.net")).toBeNull();
  });

  it("IA e colega levam rótulo só na primeira do bloco", () => {
    const ai = msg({ direction: "outbound", senderType: "ai", senderId: "bot", sender: { name: "Clara" } });
    const { rerender } = render(
      <MessageBubble message={ai} channel="whatsapp" canInteract currentMemberId="me" run={{ first: true, last: false, showSender: true }} {...handlers} />
    );
    expect(screen.getByText("IA · Clara")).toBeInTheDocument();
    rerender(
      <MessageBubble message={ai} channel="whatsapp" canInteract currentMemberId="me" run={{ first: false, last: true, showSender: false }} {...handlers} />
    );
    expect(screen.queryByText("IA · Clara")).toBeNull();
  });

  it("hora inline: espaçador invisível no fim do texto + hora visível uma vez para leitores", () => {
    const { container } = render(<MessageBubble message={msg({})} channel="whatsapp" canInteract {...handlers} />);
    const p = screen.getByText("Oi, tudo bem?");
    const spacer = p.parentElement?.querySelector('[aria-hidden="true"].invisible');
    expect(spacer).not.toBeNull();
    expect(container.querySelectorAll("time[datetime]")).toHaveLength(1);
  });

  it("toque longo abre as ações; mexer o dedo cancela", async () => {
    vi.useFakeTimers();
    try {
      render(<MessageBubble message={msg({})} channel="whatsapp" canInteract {...handlers} />);
      const bubble = screen.getByText("Oi, tudo bem?").closest(".bubble-touch")!;
      fireEvent.pointerDown(bubble, { pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(bubble, { pointerType: "touch", clientX: 10, clientY: 40 });
      act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 50));
      expect(screen.queryByRole("menu")).toBeNull();
      fireEvent.pointerDown(bubble, { pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
      act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 50));
      expect(screen.getByRole("menu", { name: "Ações da mensagem" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Responder" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Copiar texto" })).toBeInTheDocument();
      // O clique ao soltar o dedo (cai fora da bolha, no fundo da folha) é engolido uma vez.
      const ghost = new MouseEvent("click", { bubbles: true, cancelable: true });
      document.body.dispatchEvent(ghost);
      expect(ghost.defaultPrevented).toBe(true);
      const next = new MouseEvent("click", { bubbles: true, cancelable: true });
      document.body.dispatchEvent(next);
      expect(next.defaultPrevented).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("botão de ações acessível por teclado e responder chama o handler", async () => {
    const onReply = vi.fn();
    render(<MessageBubble message={msg({})} channel="whatsapp" canInteract {...handlers} onReply={onReply} />);
    await userEvent.click(screen.getByRole("button", { name: "Ações da mensagem" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Responder" }));
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  describe("falha de entrega", () => {
    const failed = (over: Partial<InboxMessage> = {}) =>
      msg({
        direction: "outbound",
        senderType: "user",
        senderId: "me",
        deliveryStatus: "failed",
        metadata: { deliveryError: "no LID found for 5511@s.whatsapp.net from server", deliveryErrorKind: "transient" },
        deliveryRetry: { canRetry: true, requiresCheck: false, manualRetries: 0, maxManualRetries: 3, autoRetrying: false },
        ...over,
      });
    const renderFailed = (message: InboxMessage, extra: Record<string, unknown> = {}) =>
      render(<MessageBubble message={message} channel="whatsapp" canInteract currentMemberId="me" {...handlers} {...extra} />);

    it("mostra a frase em PT-BR, o texto técnico só em Detalhes, e o botão chama o handler", async () => {
      const onRetryDelivery = vi.fn();
      renderFailed(failed(), { onRetryDelivery });
      expect(screen.getByText(/Instabilidade na conexão/)).toBeInTheDocument();
      expect(screen.getByText("Detalhes")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /Tentar novamente/ }));
      expect(onRetryDelivery).toHaveBeenCalledTimes(1);
    });

    it("sem handler (sem permissão) ou sem canRetry: não há botão", () => {
      const { unmount } = renderFailed(failed());
      expect(screen.queryByRole("button", { name: /Tentar novamente/ })).toBeNull();
      unmount();
      renderFailed(
        failed({ deliveryRetry: { canRetry: false, requiresCheck: false, manualRetries: 0, maxManualRetries: 3, autoRetrying: false } }),
        { onRetryDelivery: vi.fn() }
      );
      expect(screen.queryByRole("button", { name: /Tentar novamente/ })).toBeNull();
    });

    it("pendente: botão desabilitado e 'Reenviando…'", () => {
      renderFailed(failed(), { onRetryDelivery: vi.fn(), retryingDelivery: true });
      expect(screen.getByRole("button", { name: /Reenviando…/ })).toBeDisabled();
    });

    it("reenvio automático: avisa e não mostra botão", () => {
      renderFailed(
        failed({
          deliveryStatus: undefined,
          metadata: { bridgeRetry: { kind: "transient", attempt: 1, nextAt: AT } },
          deliveryRetry: { canRetry: false, requiresCheck: false, manualRetries: 0, maxManualRetries: 3, autoRetrying: true },
        }),
        { onRetryDelivery: vi.fn() }
      );
      expect(screen.getByText("Reenviando automaticamente…")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Tentar novamente/ })).toBeNull();
    });

    it("teto de reenvios: explica em vez de botão morto", () => {
      renderFailed(
        failed({ deliveryRetry: { canRetry: false, requiresCheck: false, manualRetries: 3, maxManualRetries: 3, autoRetrying: false } }),
        { onRetryDelivery: vi.fn() }
      );
      expect(screen.getByText(/Limite de reenvios atingido/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Tentar novamente/ })).toBeNull();
    });

    it("número sem WhatsApp: orienta conferir o número", () => {
      renderFailed(failed({ metadata: { numberCheck: "not_on_whatsapp", deliveryError: "x" } }), { onRetryDelivery: vi.fn() });
      expect(screen.getByText("Este número não está no WhatsApp.")).toBeInTheDocument();
      expect(screen.getByText(/Confira o número do contato/)).toBeInTheDocument();
    });

    it("erro de tipo desconhecido mantém o texto cru", () => {
      renderFailed(failed({ metadata: { deliveryError: "falha estranha" } }));
      expect(screen.getByText("falha estranha")).toBeInTheDocument();
    });

    it("espera: botão desabilitado com a hora e reabilita sozinho quando passa", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(AT);
        renderFailed(
          failed({
            metadata: { deliveryErrorKind: "recipient_not_found", deliveryError: "x" },
            deliveryRetry: {
              canRetry: true, requiresCheck: true, manualRetries: 0, maxManualRetries: 3, autoRetrying: false,
              numberChecks: 1, maxNumberChecks: 3, retryAfter: AT + 60_000,
            },
          }),
          { onRetryDelivery: vi.fn() }
        );
        expect(screen.getByText(/Você poderá tentar de novo às/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Tentar novamente/ })).toBeDisabled();
        act(() => vi.advanceTimersByTime(61_000));
        expect(screen.queryByText(/Você poderá tentar de novo às/)).toBeNull();
        expect(screen.getByRole("button", { name: /Tentar novamente/ })).toBeEnabled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("falha ambígua mostra o aviso de possível duplicidade", () => {
      renderFailed(failed({ metadata: { deliveryErrorKind: "ambiguous", deliveryError: "timeout" } }), { onRetryDelivery: vi.fn() });
      expect(screen.getByText("Não sabemos se esta mensagem chegou ao cliente.")).toBeInTheDocument();
    });

    it("mensagem de campanha: sem botão e com a dica da campanha", () => {
      renderFailed(
        failed({
          metadata: { campaign: { id: "c1" }, deliveryErrorKind: "transient", deliveryError: "x" },
          deliveryRetry: { canRetry: false, requiresCheck: false, requiresDeliveredAck: false, manualRetries: 0, maxManualRetries: 3, autoRetrying: false },
        }),
        { onRetryDelivery: vi.fn() }
      );
      expect(screen.queryByRole("button", { name: /Tentar novamente/ })).toBeNull();
      expect(screen.getByText(/tela da campanha/)).toBeInTheDocument();
    });

    it("reenvio automático vencido troca o aviso sozinho", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(AT);
        renderFailed(
          failed({
            deliveryStatus: undefined,
            metadata: { bridgeRetry: { kind: "transient", attempt: 1, nextAt: AT + 1000 } },
            deliveryRetry: { canRetry: false, requiresCheck: false, manualRetries: 0, maxManualRetries: 3, autoRetrying: true, autoRetryNextAt: AT + 1000 },
          })
        );
        expect(screen.getByText("Reenviando automaticamente…")).toBeInTheDocument();
        act(() => vi.advanceTimersByTime(31 * 60_000));
        expect(screen.getByText("O reenvio automático não foi concluído.")).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
