import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Id } from "../../../../convex/_generated/dataModel";
import { PairingPanel } from "./PairingPanel";

const CONFIG = "cfg1" as Id<"channelConfigs">;

function setup(defaultMode: "code" | "qr", startImpl?: () => Promise<unknown>) {
  const startPairing = vi.fn(startImpl);
  const pollPairing = vi.fn().mockResolvedValue({ state: "code" });
  const onConnected = vi.fn();
  const utils = render(
    <PairingPanel
      configId={CONFIG}
      defaultMode={defaultMode}
      startPairing={startPairing}
      pollPairing={pollPairing}
      onConnected={onConnected}
    />
  );
  return { startPairing, pollPairing, onConnected, ...utils };
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function generateCode(startPairing: ReturnType<typeof vi.fn>) {
  startPairing.mockResolvedValueOnce({ state: "code", linkingCode: "abcd1234" });
  fireEvent.change(screen.getByLabelText("Número do WhatsApp"), { target: { value: "11987654321" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Gerar código" }));
  });
}

describe("PairingPanel", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("consulta o código a cada 4 s e mantém o último código", async () => {
    const { startPairing, pollPairing } = setup("code");
    await generateCode(startPairing);
    expect(screen.getByText("ABCD-1234")).toBeInTheDocument();
    await tick(3000);
    expect(pollPairing).not.toHaveBeenCalled();
    await tick(2000);
    expect(pollPairing).toHaveBeenCalledTimes(1);
    expect(pollPairing).toHaveBeenCalledWith({ configId: CONFIG, mode: "code" });
    // O poll não reenvia o código: ele continua na tela.
    expect(screen.getByText("ABCD-1234")).toBeInTheDocument();
  });

  it("para de consultar depois de 3 minutos (com um poll final) e oferece Já digitei o código", async () => {
    const { startPairing, pollPairing } = setup("code");
    await generateCode(startPairing);
    await tick(181_000);
    const calls = pollPairing.mock.calls.length;
    expect(calls).toBeGreaterThan(30);
    await tick(20_000);
    expect(pollPairing.mock.calls.length).toBe(calls);
    const resume = screen.getByRole("button", { name: "Já digitei o código" });
    fireEvent.click(resume);
    await tick(10_000);
    expect(pollPairing.mock.calls.length).toBeGreaterThan(calls);
  });

  it("avisa que o código pode ter vencido aos 2 minutos e libera outro aos 150 s", async () => {
    const { startPairing } = setup("code");
    await generateCode(startPairing);
    await tick(121_000);
    expect(screen.getByText("O código pode ter vencido. Gere outro.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gerar outro código" })).toBeDisabled();
    await tick(30_000);
    expect(screen.getByRole("button", { name: "Gerar outro código" })).toBeEnabled();
  });

  it("conectado chama onConnected", async () => {
    const { startPairing, pollPairing, onConnected } = setup("code");
    await generateCode(startPairing);
    pollPairing.mockResolvedValue({ state: "connected", displayPhoneNumber: "+55 11 98765-4321" });
    await tick(5000);
    expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ fresh: true, displacedFrom: [] }));
    expect(screen.getByText("Número conectado")).toBeInTheDocument();
  });

  it("limpa o timer ao desmontar", async () => {
    const { startPairing, pollPairing, unmount } = setup("code");
    await generateCode(startPairing);
    unmount();
    await tick(30_000);
    expect(pollPairing).not.toHaveBeenCalled();
  });

  it("troca erro técnico do servidor por texto genérico", async () => {
    const { startPairing } = setup("code");
    startPairing.mockResolvedValueOnce({ state: "error", error: "gateway HTTP 502" });
    fireEvent.change(screen.getByLabelText("Número do WhatsApp"), { target: { value: "11987654321" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Gerar código" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível conectar agora. Tente de novo em instantes.");
  });

  it("QR: erro permanente (ConvexError) para o poll e mostra Tentar de novo", async () => {
    const { ConvexError } = await import("convex/values");
    const { pollPairing } = setup("qr", () => Promise.reject(new ConvexError("Entre com uma conta com e-mail.")));
    await tick(10);
    expect(screen.getByText("Entre com uma conta com e-mail.")).toBeInTheDocument();
    await tick(20_000);
    expect(pollPairing).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });
});
