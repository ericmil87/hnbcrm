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
});
