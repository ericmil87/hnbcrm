import { StrictMode, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useOnboardingStream, type OnboardingTurnResult } from "./useOnboardingStream";

const enc = new TextEncoder();
const AUDIO_URL = "https://abc.convex.cloud/api/storage/a1";

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
    error: (e: unknown) => ctrl.error(e),
  };
}

/** fetch que devolve um corpo controlável por chamada e o erra no abort (como o navegador). */
function streamingFetch() {
  const bodies: ReturnType<typeof controlledBody>[] = [];
  const signals: AbortSignal[] = [];
  const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
    const ctl = controlledBody();
    bodies.push(ctl);
    if (init.signal) {
      signals.push(init.signal);
      init.signal.addEventListener("abort", () => ctl.error(new DOMException("Aborted", "AbortError")));
    }
    return new Response(ctl.body, { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, mock: fetchImpl, bodies, signals };
}

function setup(fetchImpl: typeof fetch, token: string | null = "tok", wrapper?: ({ children }: { children: ReactNode }) => ReactNode) {
  const onSession = vi.fn();
  const hook = renderHook(
    () => useOnboardingStream({ organizationId: "org1", sessionId: "s1", token, fetchImpl, siteUrl: "https://x.convex.site", onSession }),
    wrapper ? { wrapper } : undefined
  );
  return { ...hook, onSession };
}

describe("useOnboardingStream", () => {
  it("aplica os eventos em ordem, destrava no done e aceita o audio que vem depois", async () => {
    const f = streamingFetch();
    const { result, onSession } = setup(f.fetchImpl);

    let sendPromise!: Promise<OnboardingTurnResult>;
    act(() => {
      sendPromise = result.current.send({ text: "  Oi  " });
    });
    expect(result.current.isStreaming).toBe(true);
    await waitFor(() => expect(f.bodies).toHaveLength(1));
    const init = f.mock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ organizationId: "org1", sessionId: "s1", text: "Oi" });
    const ctl = f.bodies[0];

    act(() => ctl.push({ type: "session", sessionId: "s1" }, { type: "status", text: "Pensando…" }));
    await waitFor(() => expect(result.current.turn?.status).toBe("Pensando…"));
    expect(onSession).toHaveBeenCalledWith("s1");

    act(() =>
      ctl.push(
        { type: "delta", text: "Olá, " },
        { type: "delta", text: "tudo bem?" },
        { type: "block", block: { kind: "funilPreview" } },
        { type: "chips", chips: ["Sim", "Não"] },
        { type: "done", nextStage: "interview", askForMaterials: false }
      )
    );
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
      ctl.push({ type: "audio", url: AUDIO_URL, durationSec: 2.5, mimeType: "audio/wav" });
      ctl.close();
    });
    await act(async () => {
      expect(await sendPromise).toBe("ok");
    });
    expect(result.current.turn?.audio).toEqual({ url: AUDIO_URL, durationSec: 2.5, mimeType: "audio/wav" });
    expect(result.current.awaitingAudio).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("áudio com URL fora do storage do Convex é ignorado", async () => {
    const f = streamingFetch();
    const { result } = setup(f.fetchImpl);
    let p!: Promise<OnboardingTurnResult>;
    act(() => {
      p = result.current.send({ text: "Oi" });
    });
    await waitFor(() => expect(f.bodies).toHaveLength(1));
    act(() => {
      f.bodies[0].push(
        { type: "done" },
        { type: "audio", url: "http://abc.convex.cloud/a.wav" },
        { type: "audio", url: "https://mal.example/a.wav" }
      );
      f.bodies[0].close();
    });
    await act(async () => {
      expect(await p).toBe("ok");
    });
    expect(result.current.turn?.audio).toBeNull();
  });

  it("turno novo aborta a espera do áudio do anterior: o anterior é ok e não mexe no novo", async () => {
    const f = streamingFetch();
    const { result } = setup(f.fetchImpl);
    let first!: Promise<OnboardingTurnResult>;
    act(() => {
      first = result.current.send({ text: "um" });
    });
    await waitFor(() => expect(f.bodies).toHaveLength(1));
    act(() => f.bodies[0].push({ type: "delta", text: "Resposta 1" }, { type: "done" }));
    await waitFor(() => expect(result.current.awaitingAudio).toBe(true));

    let second!: Promise<OnboardingTurnResult>;
    act(() => {
      second = result.current.send({ text: "dois" });
    });
    expect(f.signals[0].aborted).toBe(true);
    await act(async () => {
      expect(await first).toBe("ok");
    });
    // O turno novo segue intacto, sem erro do anterior.
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.turn?.replyText).toBe("");
    await waitFor(() => expect(f.bodies).toHaveLength(2));
    act(() => {
      f.bodies[1].push({ type: "delta", text: "Resposta 2" }, { type: "done" });
      f.bodies[1].close();
    });
    await act(async () => {
      expect(await second).toBe("ok");
    });
    expect(result.current.turn?.replyText).toBe("Resposta 2");
  });

  it("abort() antes do done = superseded, sem erro na tela", async () => {
    const f = streamingFetch();
    const { result } = setup(f.fetchImpl);
    let p!: Promise<OnboardingTurnResult>;
    act(() => {
      p = result.current.send({ text: "Oi" });
    });
    await waitFor(() => expect(f.bodies).toHaveLength(1));
    act(() => result.current.abort());
    await act(async () => {
      expect(await p).toBe("superseded");
    });
    expect(result.current.error).toBeNull();
    expect(result.current.isStreaming).toBe(false);
  });

  it("ignora um segundo envio enquanto o turno não chegou ao done", async () => {
    const f = streamingFetch();
    const { result } = setup(f.fetchImpl);
    act(() => {
      void result.current.send({ text: "um" });
    });
    let second: OnboardingTurnResult | undefined;
    await act(async () => {
      second = await result.current.send({ text: "dois" });
    });
    expect(second).toBe("failed");
    expect(f.mock).toHaveBeenCalledTimes(1);
  });

  it("erro HTTP (429) vira failed com mensagem PT-BR; sem token não chama a rede", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "Calma.", code: "rate_limited", retryAfterMs: 60000 }), { status: 429 })
    ) as unknown as typeof fetch;
    const { result } = setup(fetchImpl);
    await act(async () => {
      expect(await result.current.send({ text: "Oi" })).toBe("failed");
    });
    expect(result.current.error).toEqual({ code: "rate_limited", message: "Calma. Tente de novo em 1 minuto.", retryAfterMs: 60000 });
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();

    const noNet = vi.fn() as unknown as typeof fetch;
    const anon = setup(noNet, null);
    await act(async () => {
      expect(await anon.result.current.send({ text: "Oi" })).toBe("failed");
    });
    expect(noNet).not.toHaveBeenCalled();
    expect(anon.result.current.error?.code).toBe("unauthenticated");
  });

  it("aborta a conexão ao desmontar (de verdade), mas não na remontagem do StrictMode", async () => {
    const f = streamingFetch();
    const { result, unmount } = setup(f.fetchImpl, "tok", ({ children }) => <StrictMode>{children}</StrictMode>);
    act(() => {
      void result.current.send({ text: "Oi" });
    });
    await waitFor(() => expect(f.signals).toHaveLength(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(f.signals[0].aborted).toBe(false);
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(f.signals[0].aborted).toBe(true);
  });
});
