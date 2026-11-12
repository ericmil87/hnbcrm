import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useOnboardingStream } from "./useOnboardingStream";

const enc = new TextEncoder();

function controlledBody() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    body,
    push: (...events: Record<string, unknown>[]) =>
      ctrl.enqueue(enc.encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""))),
    close: () => ctrl.close(),
  };
}

function setup(fetchImpl: typeof fetch, token: string | null = "tok") {
  const onSession = vi.fn();
  const hook = renderHook(() =>
    useOnboardingStream({ organizationId: "org1", sessionId: "s1", token, fetchImpl, siteUrl: "https://x.convex.site", onSession })
  );
  return { ...hook, onSession };
}

describe("useOnboardingStream", () => {
  it("aplica os eventos em ordem, destrava no done e aceita o audio que vem depois", async () => {
    const ctl = controlledBody();
    const fetchImpl = vi.fn(async () => new Response(ctl.body, { status: 200 })) as unknown as typeof fetch;
    const { result, onSession } = setup(fetchImpl);

    let sendPromise!: Promise<boolean>;
    act(() => {
      sendPromise = result.current.send({ text: "  Oi  " });
    });
    expect(result.current.isStreaming).toBe(true);
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ organizationId: "org1", sessionId: "s1", text: "Oi" });

    act(() => {
      ctl.push(
        { type: "session", sessionId: "s1" },
        { type: "status", text: "Pensando…" }
      );
    });
    await waitFor(() => expect(result.current.turn?.status).toBe("Pensando…"));
    expect(onSession).toHaveBeenCalledWith("s1");

    act(() => {
      ctl.push(
        { type: "delta", text: "Olá, " },
        { type: "delta", text: "tudo bem?" },
        { type: "block", block: { kind: "funilPreview" } },
        { type: "chips", chips: ["Sim", "Não"] },
        { type: "done", nextStage: "interview", askForMaterials: false }
      );
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    expect(result.current.awaitingAudio).toBe(true);
    expect(result.current.turn).toMatchObject({
      replyText: "Olá, tudo bem?",
      status: null,
      chips: ["Sim", "Não"],
      done: { nextStage: "interview", askForMaterials: false },
    });
    expect(result.current.turn?.blocks).toHaveLength(1);

    act(() => {
      ctl.push({ type: "audio", url: "https://x/a.wav", durationSec: 2.5, mimeType: "audio/wav" });
      ctl.close();
    });
    await act(async () => {
      expect(await sendPromise).toBe(true);
    });
    expect(result.current.turn?.audio).toEqual({ url: "https://x/a.wav", durationSec: 2.5, mimeType: "audio/wav" });
    expect(result.current.awaitingAudio).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("ignora um segundo envio enquanto o turno não terminou", async () => {
    const ctl = controlledBody();
    const fetchImpl = vi.fn(async () => new Response(ctl.body, { status: 200 })) as unknown as typeof fetch;
    const { result } = setup(fetchImpl);
    act(() => {
      void result.current.send({ text: "um" });
    });
    let second: boolean | undefined;
    await act(async () => {
      second = await result.current.send({ text: "dois" });
    });
    expect(second).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    act(() => {
      ctl.push({ type: "done" });
      ctl.close();
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));
  });

  it("erro HTTP (429) vira error PT-BR com espera; sem token não chama a rede", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "Calma.", code: "rate_limited", retryAfterMs: 60000 }), { status: 429 })
    ) as unknown as typeof fetch;
    const { result } = setup(fetchImpl);
    await act(async () => {
      expect(await result.current.send({ text: "Oi" })).toBe(false);
    });
    expect(result.current.error).toEqual({ code: "rate_limited", message: "Calma. Tente de novo em 1 minuto.", retryAfterMs: 60000 });
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();

    const noNet = vi.fn() as unknown as typeof fetch;
    const anon = setup(noNet, null);
    await act(async () => {
      expect(await anon.result.current.send({ text: "Oi" })).toBe(false);
    });
    expect(noNet).not.toHaveBeenCalled();
    expect(anon.result.current.error?.code).toBe("unauthenticated");
  });

  it("aborta a conexão ao desmontar", async () => {
    let signal: AbortSignal | undefined;
    const ctl = controlledBody();
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response(ctl.body, { status: 200 });
    }) as unknown as typeof fetch;
    const { result, unmount } = setup(fetchImpl);
    act(() => {
      void result.current.send({ text: "Oi" });
    });
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
