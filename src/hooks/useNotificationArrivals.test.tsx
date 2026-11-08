import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const toastMock = vi.fn();
vi.mock("sonner", () => ({ toast: (...args: unknown[]) => toastMock(...args) }));

import { useNotificationArrivals, type ArrivalNotification } from "./useNotificationArrivals";

const mk = (over: Partial<ArrivalNotification> & { _id: string }): ArrivalNotification => ({
  type: "handoff_requested",
  // ids em ordem alfabética = ordem de chegada (a < b < c ...)
  createdAt: 1000 + over._id.charCodeAt(0),
  title: "Pedido de ajuda",
  ...over,
});

interface Props {
  items: ArrivalNotification[] | undefined;
  unread?: number;
  open?: string | null;
  suppressed?: boolean;
}

function setup(initial: Props) {
  const onOpen = vi.fn();
  const onOpenInbox = vi.fn();
  const hook = renderHook(
    (p: Props) =>
      useNotificationArrivals({
        items: p.items,
        unreadCount: p.unread,
        openConversationId: p.open ?? null,
        suppressed: p.suppressed,
        onOpen,
        onOpenInbox,
      }),
    { initialProps: initial },
  );
  return { ...hook, onOpen, onOpenInbox };
}

beforeEach(() => {
  toastMock.mockClear();
  localStorage.clear();
  document.title = "Conversas · HNBCRM";
});

describe("useNotificationArrivals", () => {
  it("não avisa no carregamento inicial", () => {
    setup({ items: [mk({ _id: "a" })], unread: 1 });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("espera os dados chegarem antes de semear", () => {
    const { rerender } = setup({ items: undefined });
    rerender({ items: [mk({ _id: "a" })] });
    expect(toastMock).not.toHaveBeenCalled();
    rerender({ items: [mk({ _id: "b" }), mk({ _id: "a" })] });
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("janela vazia no início semeia com 'agora': o que chega depois avisa", () => {
    const { rerender } = setup({ items: [] });
    rerender({ items: [mk({ _id: "a", createdAt: Date.now() + 1000 })] });
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("janela que desliza: itens antigos que entram não avisam", () => {
    const { rerender } = setup({ items: [mk({ _id: "e" }), mk({ _id: "d" })] });
    // o usuário leu os mais novos: entram na janela os antigos a, b, c
    rerender({ items: [mk({ _id: "d" }), mk({ _id: "c" }), mk({ _id: "b" }), mk({ _id: "a" })] });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("markUnread de item antigo (volta ao topo da lista) não avisa", () => {
    const { rerender } = setup({ items: [mk({ _id: "e" })] });
    rerender({ items: [mk({ _id: "e" }), mk({ _id: "b" })] });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("aviso agrupado renovado (mesmo id, createdAt novo) avisa de novo", () => {
    const { rerender } = setup({ items: [mk({ _id: "a", type: "new_message" })] });
    rerender({ items: [mk({ _id: "a", type: "new_message", createdAt: 9000 })] });
    expect(toastMock).toHaveBeenCalledTimes(1);
    rerender({ items: [mk({ _id: "a", type: "new_message", createdAt: 9000 })] });
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("com o painel do sino aberto não avisa, e o que chegou nele não avisa depois", () => {
    const { rerender } = setup({ items: [mk({ _id: "a" })], suppressed: false });
    rerender({ items: [mk({ _id: "b" }), mk({ _id: "a" })], suppressed: true });
    expect(toastMock).not.toHaveBeenCalled();
    rerender({ items: [mk({ _id: "b" }), mk({ _id: "a" })], suppressed: false });
    expect(toastMock).not.toHaveBeenCalled();
    rerender({ items: [mk({ _id: "c" }), mk({ _id: "b" }), mk({ _id: "a" })], suppressed: false });
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("avisa o que chega depois, com Abrir, e não repete", () => {
    const { rerender, onOpen } = setup({ items: [mk({ _id: "a" })], unread: 1 });
    const fresh = mk({ _id: "b", title: "Nova transferência", type: "conversation_transferred" });
    rerender({ items: [fresh, mk({ _id: "a" })], unread: 2 });
    expect(toastMock).toHaveBeenCalledTimes(1);
    const [title, opts] = toastMock.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
    expect(title).toBe("Nova transferência");
    expect(opts.action.label).toBe("Abrir");
    opts.action.onClick();
    expect(onOpen).toHaveBeenCalledWith(fresh);
    // mesma lista de novo (ex.: re-render do Convex): sem aviso extra
    rerender({ items: [{ ...fresh }, mk({ _id: "a" })], unread: 2 });
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("não avisa mensagem da conversa que está aberta", () => {
    const { rerender } = setup({ items: [mk({ _id: "a" })], unread: 0, open: "c1" });
    rerender({
      items: [mk({ _id: "m", type: "new_message", conversationId: "c1" })],
      unread: 1,
      open: "c1",
    });
    expect(toastMock).not.toHaveBeenCalled();
    rerender({
      items: [
        mk({ _id: "n", type: "new_message", conversationId: "c2" }),
        mk({ _id: "m", type: "new_message", conversationId: "c1" }),
      ],
      unread: 2,
      open: "c1",
    });
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("muitos de uma vez viram um aviso só", () => {
    const { rerender, onOpenInbox } = setup({ items: [mk({ _id: "a" })], unread: 0 });
    rerender({ items: ["b", "c", "d", "e"].map((id) => mk({ _id: id })), unread: 4 });
    expect(toastMock).toHaveBeenCalledTimes(1);
    const [title, opts] = toastMock.mock.calls[0] as [string, { action: { onClick: () => void } }];
    expect(title).toBe("4 novos avisos");
    opts.action.onClick();
    expect(onOpenInbox).toHaveBeenCalled();
  });

  it("título da aba ganha (n) e acompanha mudança de página", async () => {
    const { rerender, unmount } = setup({ items: [], unread: 3 });
    expect(document.title).toBe("(3) Conversas · HNBCRM");
    rerender({ items: [], unread: 5 });
    expect(document.title).toBe("(5) Conversas · HNBCRM");
    // a página troca o título: o observador reaplica o prefixo
    document.title = "Tarefas · HNBCRM";
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.title).toBe("(5) Tarefas · HNBCRM");
    rerender({ items: [], unread: 0 });
    expect(document.title).toBe("Tarefas · HNBCRM");
    unmount();
  });

  it("usa setAppBadge/clearAppBadge quando existem", () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { setAppBadge, clearAppBadge });
    const { rerender } = setup({ items: [], unread: 2 });
    expect(setAppBadge).toHaveBeenCalledWith(2);
    rerender({ items: [], unread: 0 });
    expect(clearAppBadge).toHaveBeenCalled();
    delete (navigator as unknown as Record<string, unknown>).setAppBadge;
    delete (navigator as unknown as Record<string, unknown>).clearAppBadge;
  });

  it("som só toca com a preferência ligada (padrão desligado)", async () => {
    const created: number[] = [];
    class FakeAudio {
      state = "running";
      currentTime = 0;
      destination = {};
      constructor() {
        created.push(1);
      }
      createOscillator() {
        return { type: "", frequency: { value: 0 }, connect: (n: unknown) => n, start() {}, stop() {} };
      }
      createGain() {
        return {
          gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect: (n: unknown) => n,
        };
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudio;
    const { rerender } = setup({ items: [mk({ _id: "a" })], unread: 0 });
    rerender({ items: [mk({ _id: "b" }), mk({ _id: "a" })], unread: 1 });
    expect(created).toHaveLength(0);
    localStorage.setItem("hnbcrm.notifySound", "1");
    rerender({ items: [mk({ _id: "c" }), mk({ _id: "b" }), mk({ _id: "a" })], unread: 2 });
    expect(created).toHaveLength(1);
    delete (window as unknown as Record<string, unknown>).AudioContext;
  });
});
