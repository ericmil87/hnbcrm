import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { toast } from "sonner";

const retryAction = vi.fn();
vi.mock("convex/react", () => ({ useAction: () => retryAction }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { NOT_FOUND_SEND_ERROR as NOT_FOUND_TEXT } from "@/lib/messageDelivery";
import { useNotOnWhatsappAck } from "./useNotOnWhatsappAck";
import { useRetryDelivery } from "./useRetryDelivery";

beforeEach(() => {
  retryAction.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

describe("useNotOnWhatsappAck", () => {
  it("erro com o prefixo abre o diálogo; confirmar reenvia; cancelar não envia", () => {
    const { result } = renderHook(() => useNotOnWhatsappAck());
    const resend = vi.fn();
    let handled = false;
    act(() => {
      handled = result.current.intercept(new ConvexError("NOT_ON_WHATSAPP: sem conta"), resend);
    });
    expect(handled).toBe(true);
    expect(result.current.dialogProps.open).toBe(true);
    expect(result.current.dialogProps.confirmLabel).toBe("Enviar mesmo assim");
    expect(resend).not.toHaveBeenCalled();

    act(() => result.current.dialogProps.onClose());
    expect(result.current.dialogProps.open).toBe(false);
    expect(resend).not.toHaveBeenCalled();

    act(() => {
      result.current.intercept(new ConvexError("NOT_ON_WHATSAPP: sem conta"), resend);
    });
    act(() => {
      result.current.dialogProps.onConfirm();
      result.current.dialogProps.onClose();
    });
    expect(resend).toHaveBeenCalledTimes(1);
    expect(result.current.dialogProps.open).toBe(false);
  });

  it("caso 'não encontrado': o diálogo não afirma que não há conta", () => {
    const { result } = renderHook(() => useNotOnWhatsappAck());
    act(() => {
      result.current.intercept(new ConvexError(`NOT_ON_WHATSAPP: ${NOT_FOUND_TEXT}`), vi.fn());
    });
    expect(result.current.dialogProps.title).toBe("O WhatsApp não encontrou este número");
    expect(result.current.dialogProps.description).not.toContain("não tem conta");
  });

  it("outros erros não abrem o diálogo", () => {
    const { result } = renderHook(() => useNotOnWhatsappAck());
    let handled = true;
    act(() => {
      handled = result.current.intercept(new Error("falhou"), vi.fn());
    });
    expect(handled).toBe(false);
    expect(result.current.dialogProps.open).toBe(false);
  });
});

describe("useRetryDelivery", () => {
  it("falha normal: chama a action sem aceite e avisa o sucesso", async () => {
    retryAction.mockResolvedValue({ ok: true, correctedNumber: true });
    const { result } = renderHook(() => useRetryDelivery());
    await act(() => result.current.retryDelivery({ _id: "m1", deliveryRetry: { requiresDeliveredAck: false } }));
    expect(retryAction).toHaveBeenCalledWith({ messageId: "m1" });
    expect(toast.success).toHaveBeenCalledWith("Número corrigido e mensagem reenviada");
  });

  it("ambígua: abre o diálogo antes de chamar; confirmar manda maybeDeliveredAck", async () => {
    retryAction.mockResolvedValue({ ok: true, correctedNumber: false });
    const { result } = renderHook(() => useRetryDelivery());
    await act(() => result.current.retryDelivery({ _id: "m1", deliveryRetry: { requiresDeliveredAck: true } }));
    expect(retryAction).not.toHaveBeenCalled();
    expect(result.current.ackDialogProps.open).toBe(true);

    await act(async () => {
      result.current.ackDialogProps.onConfirm();
    });
    expect(retryAction).toHaveBeenCalledWith({ messageId: "m1", maybeDeliveredAck: true });
  });

  it("cancelar o diálogo não reenvia", async () => {
    const { result } = renderHook(() => useRetryDelivery());
    await act(() => result.current.retryDelivery({ _id: "m1", deliveryRetry: { requiresDeliveredAck: true } }));
    act(() => result.current.ackDialogProps.onClose());
    expect(result.current.ackDialogProps.open).toBe(false);
    expect(retryAction).not.toHaveBeenCalled();
  });

  it("recusa maybe_delivered (flag velha) abre o mesmo diálogo", async () => {
    retryAction.mockResolvedValueOnce({ ok: false, reason: "maybe_delivered", message: "pode ter chegado" });
    const { result } = renderHook(() => useRetryDelivery());
    await act(() => result.current.retryDelivery({ _id: "m1" }));
    expect(result.current.ackDialogProps.open).toBe(true);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("outras recusas mostram a mensagem do servidor (check_wait inclusive)", async () => {
    retryAction.mockResolvedValue({ ok: false, reason: "check_wait", message: "aguarde alguns minutos", retryAfter: 1 });
    const { result } = renderHook(() => useRetryDelivery());
    await act(() => result.current.retryDelivery({ _id: "m1" }));
    expect(toast.error).toHaveBeenCalledWith("aguarde alguns minutos");
    expect(result.current.ackDialogProps.open).toBe(false);
  });
});
