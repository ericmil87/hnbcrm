import { describe, expect, it, vi } from "vitest";
import {
  convexSiteUrl,
  createSseParser,
  decodeSseData,
  formatRetryWait,
  onboardingErrorMessage,
  onboardingEventKey,
  parseOnboardingEvent,
  readHttpError,
  runOnboardingTurnRequest,
  safeAudioUrl,
  type OnboardingStreamEvent,
} from "./onboardingStream";

const enc = new TextEncoder();

/** Stream controlável: `push` enfileira texto, `close` fecha. */
function controlledBody() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    body,
    push: (text: string) => ctrl.enqueue(enc.encode(text)),
    close: () => ctrl.close(),
    error: (e: unknown) => ctrl.error(e),
  };
}

function sse(...events: Record<string, unknown>[]) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

function streamResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const BODY = { organizationId: "org1", sessionId: "s1", text: "Oi" };

describe("createSseParser", () => {
  it("junta pedaços quebrados no meio da linha e do JSON", () => {
    const out: string[] = [];
    const p = createSseParser((d) => out.push(d));
    const text = sse({ type: "delta", text: "Olá" }, { type: "delta", text: " mundo" });
    for (const ch of text) p.push(ch); // um caractere por vez
    expect(out.map((d) => JSON.parse(d).text)).toEqual(["Olá", " mundo"]);
  });

  it("aceita \\r\\n (inclusive dividido entre pedaços), \\r, comentários e campos event/id", () => {
    const out: string[] = [];
    const p = createSseParser((d) => out.push(d));
    p.push(": ping\r\nevent: x\r\nid: 1\r\ndata: {\"a\":1}\r");
    p.push("\n\r\n");
    p.push("data: {\"b\":2}\r\r");
    // `\r` no fim do pedaço pode ser metade de um `\r\n`: só fecha no próximo pedaço ou no fim.
    expect(out).toEqual(['{"a":1}']);
    p.end();
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("várias linhas data: viram um evento com \\n; data sem espaço também vale", () => {
    const out: string[] = [];
    const p = createSseParser((d) => out.push(d));
    p.push("data:linha1\ndata: linha2\n\n");
    expect(out).toEqual(["linha1\nlinha2"]);
  });

  it("end() despacha o último evento sem linha em branco final", () => {
    const out: string[] = [];
    const p = createSseParser((d) => out.push(d));
    p.push('data: {"type":"done"}');
    expect(out).toEqual([]);
    p.end();
    expect(out).toEqual(['{"type":"done"}']);
  });
});

describe("parseOnboardingEvent / decodeSseData", () => {
  it("valida cada tipo do contrato", () => {
    expect(parseOnboardingEvent({ type: "session", sessionId: "s1" })).toEqual({ type: "session", sessionId: "s1" });
    expect(parseOnboardingEvent({ type: "chips", chips: ["a", 1, "b"] })).toEqual({ type: "chips", chips: ["a", "b"] });
    expect(parseOnboardingEvent({ type: "done", nextStage: "draft", askForMaterials: true })).toEqual({
      type: "done",
      nextStage: "draft",
      askForMaterials: true,
    });
    expect(parseOnboardingEvent({ type: "done" })).toEqual({ type: "done", nextStage: null, askForMaterials: false });
    expect(parseOnboardingEvent({ type: "audio", url: "https://abc.convex.cloud/api/storage/a1", durationSec: 3.2, mimeType: "audio/wav" })).toEqual({
      type: "audio",
      url: "https://abc.convex.cloud/api/storage/a1",
      durationSec: 3.2,
      mimeType: "audio/wav",
    });
    expect(parseOnboardingEvent({ type: "block", block: { kind: "chips", options: [] } })?.type).toBe("block");
  });

  it("descarta o que não casa (tipo desconhecido, campos errados, JSON quebrado)", () => {
    expect(parseOnboardingEvent({ type: "tool", name: "x" })).toBeNull();
    expect(parseOnboardingEvent({ type: "delta", text: 3 })).toBeNull();
    expect(parseOnboardingEvent({ type: "block", block: [1] })).toBeNull();
    expect(parseOnboardingEvent({ type: "audio", url: "" })).toBeNull();
    expect(parseOnboardingEvent(null)).toBeNull();
    expect(decodeSseData("{quebrado")).toBeNull();
  });

  it("erro: código desconhecido vira `error`; mensagem do servidor vence; sem ela, o padrão", () => {
    expect(parseOnboardingEvent({ type: "error", code: "budget", message: "Limite do dia atingido." })).toEqual({
      type: "error",
      code: "budget",
      message: "Limite do dia atingido.",
    });
    const unknown = parseOnboardingEvent({ type: "error", code: "xyz" });
    expect(unknown).toMatchObject({ type: "error", code: "error" });
    expect((unknown as { message: string }).message).toMatch(/Algo deu errado/);
  });
});

describe("safeAudioUrl", () => {
  it("só https no storage do Convex (ou no host do deployment)", () => {
    expect(safeAudioUrl("https://abc.convex.cloud/api/storage/x")).toBe("https://abc.convex.cloud/api/storage/x");
    expect(safeAudioUrl("https://abc.convex.site/x")).toBe("https://abc.convex.site/x");
    expect(safeAudioUrl("http://abc.convex.cloud/x")).toBeNull();
    expect(safeAudioUrl("https://mal.example/x.wav")).toBeNull();
    expect(safeAudioUrl("https://convex.cloud.mal.example/x")).toBeNull();
    expect(safeAudioUrl("https://u:p@abc.convex.cloud/x")).toBeNull();
    expect(safeAudioUrl("javascript:alert(1)")).toBeNull();
    expect(safeAudioUrl("data:audio/wav;base64,AAAA")).toBeNull();
    expect(safeAudioUrl(42)).toBeNull();
    expect(safeAudioUrl("https://convex.minha-empresa.com/s/1", "convex.minha-empresa.com")).toBe("https://convex.minha-empresa.com/s/1");
  });
});

describe("mensagens de erro", () => {
  it("cada código tem texto PT-BR padrão", () => {
    for (const code of ["email_unverified", "notice_required", "rate_limited", "budget", "invalid_input", "forbidden", "material_failed"] as const) {
      const msg = onboardingErrorMessage(code);
      expect(msg.length).toBeGreaterThan(10);
      expect(msg).not.toMatch(/error|failed/i);
    }
  });

  it("rate_limited com espera acrescenta o tempo (quando a mensagem não tem número)", () => {
    expect(onboardingErrorMessage("rate_limited", null, 90_000)).toMatch(/Tente de novo em 2 minutos\.$/);
    expect(onboardingErrorMessage("rate_limited", "Espere 5 minutos.", 90_000)).toBe("Espere 5 minutos.");
    expect(formatRetryWait(1000)).toBe("1 segundo");
    expect(formatRetryWait(45_000)).toBe("45 segundos");
    expect(formatRetryWait(60_000)).toBe("1 minuto");
  });

  it("readHttpError: 429 com code/retryAfterMs, 401 sem code, 400 técnico usa o padrão", async () => {
    const r429 = await readHttpError(
      new Response(JSON.stringify({ error: "Muitas tentativas.", code: "rate_limited", retryAfterMs: 120000 }), { status: 429 })
    );
    expect(r429).toEqual({ code: "rate_limited", message: "Muitas tentativas. Tente de novo em 2 minutos.", retryAfterMs: 120000 });
    const r401 = await readHttpError(new Response(JSON.stringify({ error: "Entre na sua conta para continuar." }), { status: 401 }));
    expect(r401.code).toBe("unauthenticated");
    const r400 = await readHttpError(new Response(JSON.stringify({ error: "Corpo inválido: organizationId" }), { status: 400 }));
    expect(r400.code).toBe("invalid_input");
    expect(r400.message).not.toMatch(/organizationId/);
    const r403 = await readHttpError(new Response("nada", { status: 403 }));
    expect(r403.code).toBe("forbidden");
  });

  it("convexSiteUrl troca .cloud por .site", () => {
    expect(convexSiteUrl("https://abc.convex.cloud/")).toBe("https://abc.convex.site");
    expect(convexSiteUrl(undefined)).toBe("");
  });
});

describe("runOnboardingTurnRequest", () => {
  it("POST com Bearer e corpo; eventos em ordem; ok no done", async () => {
    const fetchImpl = vi.fn(async () =>
      streamResponse([
        sse({ type: "session", sessionId: "s1" }, { type: "status", text: "Pensando…" }).slice(0, 30),
        sse({ type: "session", sessionId: "s1" }, { type: "status", text: "Pensando…" }).slice(30),
        sse(
          { type: "delta", text: "Oi" },
          { type: "block", block: { kind: "chips", options: ["a"] } },
          { type: "chips", chips: ["a", "b"] },
          { type: "draft", version: 2, hash: "h" },
          { type: "done", nextStage: "interview", askForMaterials: false }
        ),
      ])
    );
    const events: OnboardingStreamEvent["type"][] = [];
    const outcome = await runOnboardingTurnRequest({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      siteUrl: "https://x.convex.site",
      token: "tok",
      body: BODY,
      onEvent: (e) => events.push(e.type),
    });
    expect(outcome).toEqual({ ok: true, done: { nextStage: "interview", askForMaterials: false } });
    expect(events).toEqual(["session", "status", "delta", "block", "chips", "draft", "done"]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://x.convex.site/api/onboarding/stream");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual(BODY);
  });

  it("audio depois do done: onDone chega antes, a leitura continua até o servidor fechar", async () => {
    const ctl = controlledBody();
    const fetchImpl = vi.fn(async () => new Response(ctl.body, { status: 200 }));
    const seen: string[] = [];
    const promise = runOnboardingTurnRequest({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      siteUrl: "",
      token: "t",
      body: BODY,
      onEvent: (e) => seen.push(e.type),
      onDone: () => seen.push("onDone"),
    });
    ctl.push(sse({ type: "delta", text: "Oi" }, { type: "done", nextStage: null, askForMaterials: false }));
    await vi.waitFor(() => expect(seen).toContain("onDone"));
    let settled = false;
    void promise.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false); // não fechou no done
    ctl.push(sse({ type: "audio", url: "https://abc.convex.cloud/api/storage/a1", durationSec: 2, mimeType: "audio/wav" }));
    ctl.close();
    const outcome = await promise;
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual(["delta", "done", "onDone", "audio"]);
  });

  it("abortar a espera do áudio (depois do done) conta como turno ok, não como abortado", async () => {
    const ctl = controlledBody();
    const ac = new AbortController();
    const promise = runOnboardingTurnRequest({
      fetchImpl: (async (_u: string, init: RequestInit) => {
        init.signal?.addEventListener("abort", () => ctl.error(new DOMException("Aborted", "AbortError")));
        return new Response(ctl.body, { status: 200 });
      }) as unknown as typeof fetch,
      siteUrl: "",
      token: "t",
      body: BODY,
      signal: ac.signal,
      onEvent: () => {},
    });
    ctl.push(sse({ type: "done", nextStage: "draft", askForMaterials: false }));
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    expect(await promise).toEqual({ ok: true, done: { nextStage: "draft", askForMaterials: false } });
  });

  it("conexão que cai depois do done ainda conta como turno ok", async () => {
    const ctl = controlledBody();
    const promise = runOnboardingTurnRequest({
      fetchImpl: (async () => new Response(ctl.body, { status: 200 })) as unknown as typeof fetch,
      siteUrl: "",
      token: "t",
      body: BODY,
      onEvent: () => {},
    });
    ctl.push(sse({ type: "done", nextStage: null, askForMaterials: false }));
    await new Promise((r) => setTimeout(r, 5));
    ctl.error(new TypeError("network"));
    expect((await promise).ok).toBe(true);
  });

  it("evento error no stream vira resultado de erro com a mensagem PT-BR", async () => {
    const outcome = await runOnboardingTurnRequest({
      fetchImpl: (async () =>
        streamResponse([sse({ type: "session", sessionId: "s" }, { type: "error", code: "budget", message: "Limite atingido." })])) as unknown as typeof fetch,
      siteUrl: "",
      token: "t",
      body: BODY,
      onEvent: () => {},
    });
    expect(outcome).toEqual({ ok: false, error: { code: "budget", message: "Limite atingido." } });
  });

  it("stream fechado sem done = erro genérico; falha de rede = network; HTTP 429 = rate_limited", async () => {
    const noDone = await runOnboardingTurnRequest({
      fetchImpl: (async () => streamResponse([sse({ type: "delta", text: "a" })])) as unknown as typeof fetch,
      siteUrl: "",
      token: "t",
      body: BODY,
      onEvent: () => {},
    });
    expect(noDone).toMatchObject({ ok: false, error: { code: "error" } });

    const net = await runOnboardingTurnRequest({
      fetchImpl: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
      siteUrl: "",
      token: "t",
      body: BODY,
      onEvent: () => {},
    });
    expect(net).toMatchObject({ ok: false, error: { code: "network" } });

    const limited = await runOnboardingTurnRequest({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "Calma.", code: "rate_limited", retryAfterMs: 30000 }), { status: 429 })) as unknown as typeof fetch,
      siteUrl: "",
      token: "t",
      body: BODY,
      onEvent: () => {},
    });
    expect(limited).toEqual({
      ok: false,
      error: { code: "rate_limited", message: "Calma. Tente de novo em 30 segundos.", retryAfterMs: 30000 },
    });
  });

  it("abort no meio do stream devolve aborted (sem erro para a tela)", async () => {
    const ctl = controlledBody();
    const ac = new AbortController();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      init.signal?.addEventListener("abort", () => ctl.error(new DOMException("Aborted", "AbortError")));
      return new Response(ctl.body, { status: 200 });
    });
    const promise = runOnboardingTurnRequest({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      siteUrl: "",
      token: "t",
      body: BODY,
      signal: ac.signal,
      onEvent: () => {},
    });
    ctl.push(sse({ type: "delta", text: "a" }));
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    expect(await promise).toEqual({ ok: false, aborted: true });
  });
});

describe("eventos de cartão", () => {
  it("o corpo leva o evento e o evento responde como um turno (sem texto da pessoa)", async () => {
    const fetchImpl = vi.fn(async () =>
      streamResponse([sse({ type: "delta", text: "Combinado." }, { type: "done", nextStage: null, askForMaterials: false })])
    );
    const seen: string[] = [];
    const outcome = await runOnboardingTurnRequest({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      siteUrl: "https://x.convex.site",
      token: "tok",
      body: { organizationId: "org1", sessionId: "s1", event: { kind: "notify", what: "activated" } },
      onEvent: (e) => seen.push(e.type),
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual(["delta", "done"]);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({
      organizationId: "org1",
      sessionId: "s1",
      event: { kind: "notify", what: "activated" },
    });
  });

  it("onboardingEventKey distingue seção, assinatura e aviso", () => {
    expect(onboardingEventKey({ kind: "approve", section: "funnel", sig: "a" })).not.toBe(
      onboardingEventKey({ kind: "approve", section: "funnel", sig: "b" })
    );
    expect(onboardingEventKey({ kind: "approve", section: "persona" })).not.toBe(onboardingEventKey({ kind: "approve", section: "funnel" }));
    expect(onboardingEventKey({ kind: "notify", what: "tested" })).toBe("notify:tested");
    expect(onboardingEventKey({ kind: "next" })).toBe("next");
  });
});
