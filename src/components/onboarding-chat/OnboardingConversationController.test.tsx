import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { HistoryMessage } from "@/lib/onboardingChat";
import { ONBOARDING_DRAFT_KEY, saveOnboardingDraft } from "@/lib/onboardingEntry";
import { readOnboardingIntent } from "@/lib/onboardingIntent";
import {
  GREETING_CHIPS,
  OnboardingConversationController,
  type ConversationHistory,
  type OnboardingConversationControllerProps,
} from "./OnboardingConversationController";

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
    error: (e: unknown) => ctrl.error(e),
  };
}

function streamingFetch() {
  const bodies: ReturnType<typeof controlledBody>[] = [];
  const texts: string[] = [];
  const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
    const ctl = controlledBody();
    bodies.push(ctl);
    texts.push(JSON.parse(init.body as string).text);
    init.signal?.addEventListener("abort", () => ctl.error(new DOMException("Aborted", "AbortError")));
    return new Response(ctl.body, { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, mock: fetchImpl, bodies, texts };
}

function msg(id: string, role: "user" | "assistant", text: string): HistoryMessage {
  return { _id: id, role, text, blocks: [], chips: [], attachment: null, createdAt: 1_800_000_000_000 };
}

const loaded = (results: HistoryMessage[] = []): ConversationHistory => ({ results, status: "Exhausted", loadMore: vi.fn() });

function props(overrides: Partial<OnboardingConversationControllerProps> = {}): OnboardingConversationControllerProps {
  return {
    organizationId: "org1",
    access: { kind: "ready" },
    sessionId: "s1",
    history: loaded(),
    chatState: { stage: "interview", lastChips: [] },
    draft: null,
    token: "tok",
    intent: null,
    siteUrl: "https://x.convex.site",
    ...overrides,
  };
}

function ui(p: OnboardingConversationControllerProps, strict = false) {
  const tree = (
    <MemoryRouter>
      <OnboardingConversationController {...p} />
    </MemoryRouter>
  );
  return strict ? <StrictMode>{tree}</StrictMode> : tree;
}

const field = () => screen.getByLabelText("Mensagem para o Copiloto") as HTMLTextAreaElement;

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i) => Array.from(m.keys())[i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}

describe("OnboardingConversationController", () => {
  beforeEach(() => vi.stubGlobal("sessionStorage", memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it("mensagem do hero: enviada uma vez (StrictMode) e não volta depois de recarregar", async () => {
    saveOnboardingDraft("Tenho uma clínica de estética", "clinica");
    const f = streamingFetch();
    const onIntentConsumed = vi.fn();
    const first = render(ui(props({ fetchImpl: f.fetchImpl, intent: readOnboardingIntent(), onIntentConsumed }), true));
    await waitFor(() => expect(f.mock).toHaveBeenCalledTimes(1));
    expect(f.texts).toEqual(["Tenho uma clínica de estética"]);
    expect(onIntentConsumed).toHaveBeenCalledTimes(1);
    // Apagada só depois que o envio começou.
    expect(sessionStorage.getItem(ONBOARDING_DRAFT_KEY)).toBeNull();
    act(() => {
      f.bodies[0].push({ type: "delta", text: "Que ótimo!" }, { type: "done" });
      f.bodies[0].close();
    });
    await screen.findByText("Que ótimo!");
    expect(screen.getAllByText("Tenho uma clínica de estética")).toHaveLength(1);
    first.unmount();

    // "Recarregar": nova montagem lendo o armazenamento de novo.
    render(ui(props({ fetchImpl: f.fetchImpl, intent: readOnboardingIntent() }), true));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(f.mock).toHaveBeenCalledTimes(1);
  });

  it("histórico carregando: campo desligado, sem saudação nem chips, nada enviado; envia quando carrega", async () => {
    saveOnboardingDraft("Vendo cursos", null);
    const intent = readOnboardingIntent();
    const f = streamingFetch();
    const loading: ConversationHistory = { results: [], status: "LoadingFirstPage", loadMore: vi.fn() };
    const view = render(ui(props({ fetchImpl: f.fetchImpl, intent, history: loading })));
    expect(field()).toBeDisabled();
    expect(screen.queryByText(/Vou montar o seu CRM/)).toBeNull();
    expect(screen.queryByRole("button", { name: GREETING_CHIPS[0] })).toBeNull();
    // A mensagem do hero aparece, mas não sai nem é apagada.
    expect(screen.getByText("Vendo cursos")).toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(f.mock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(ONBOARDING_DRAFT_KEY)).not.toBeNull();

    view.rerender(ui(props({ fetchImpl: f.fetchImpl, intent, history: loaded() })));
    await waitFor(() => expect(f.mock).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(ONBOARDING_DRAFT_KEY)).toBeNull();
  });

  it("conversa nova sem hero: saudação e chips neutros; chip envia", async () => {
    const user = userEvent.setup();
    const f = streamingFetch();
    render(ui(props({ fetchImpl: f.fetchImpl })));
    expect(screen.getByText(/Vou montar o seu CRM/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: GREETING_CHIPS[1] }));
    await waitFor(() => expect(f.texts).toEqual([GREETING_CHIPS[1]]));
  });

  it("turno novo durante a espera do áudio não é desfeito nem devolve o texto antigo ao campo", async () => {
    const user = userEvent.setup();
    const f = streamingFetch();
    render(ui(props({ fetchImpl: f.fetchImpl })));
    await user.type(field(), "Primeira{Enter}");
    await waitFor(() => expect(f.bodies).toHaveLength(1));
    act(() => f.bodies[0].push({ type: "delta", text: "Resposta um" }, { type: "done" }));
    await screen.findByText("Resposta um");

    await user.type(field(), "Segunda{Enter}");
    await waitFor(() => expect(f.bodies).toHaveLength(2));
    // O primeiro stream foi abortado; deixa as promessas assentarem.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(field().value).toBe("");
    expect(screen.getByText("Segunda")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("turno que falha (é o atual): desfaz a bolha pendente e devolve o texto ao campo", async () => {
    const user = userEvent.setup();
    const failing = vi.fn(
      async () => new Response(JSON.stringify({ error: "Calma.", code: "rate_limited" }), { status: 429 })
    ) as unknown as typeof fetch;
    render(ui(props({ fetchImpl: failing })));
    await user.type(field(), "Oi{Enter}");
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Calma.");
    expect(field().value).toBe("Oi");
    expect(screen.getByRole("button", { name: /Tentar de novo/ })).toBeInTheDocument();
  });

  it("histórico chegando durante o stream não duplica bolhas", async () => {
    const user = userEvent.setup();
    const f = streamingFetch();
    const base = [msg("a0", "assistant", "Olá!")];
    const view = render(ui(props({ fetchImpl: f.fetchImpl, history: loaded(base) })));
    await user.type(field(), "Quero vender mais{Enter}");
    await waitFor(() => expect(f.bodies).toHaveLength(1));
    act(() => f.bodies[0].push({ type: "delta", text: "Vamos lá" }));
    await screen.findByText("Vamos lá");

    // O servidor gravou as duas mensagens antes de terminar o stream.
    const withTurn = [msg("a1", "assistant", "Vamos lá, me conta mais."), msg("u1", "user", "Quero vender mais"), ...base];
    view.rerender(ui(props({ fetchImpl: f.fetchImpl, history: loaded(withTurn) })));
    expect(screen.getAllByText("Quero vender mais")).toHaveLength(1);
    expect(screen.getByText("Vamos lá, me conta mais.")).toBeInTheDocument();
    expect(screen.queryByText("Vamos lá")).toBeNull();

    act(() => {
      f.bodies[0].push({ type: "delta", text: ", me conta mais." }, { type: "done" });
      f.bodies[0].close();
    });
    await waitFor(() => expect(field()).not.toBeDisabled());
    expect(screen.getAllByText("Quero vender mais")).toHaveLength(1);
    expect(screen.getAllByText("Vamos lá, me conta mais.")).toHaveLength(1);
  });

  it("progresso em português: começa em Negócio e nunca regride (reachedStep do servidor e máximo visto na tela)", () => {
    const view = render(ui(props({ chatState: { stage: "interview", lastChips: [], reachedStep: 2 } })));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "Etapa 3 de 6: Atendente");
    // O servidor "voltou" para 0: a barra fica onde estava.
    view.rerender(ui(props({ chatState: { stage: "interview", lastChips: [], reachedStep: 0 } })));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "Etapa 3 de 6: Atendente");
  });

  it("conversa nova: etapa 1 Negócio", () => {
    render(ui(props()));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "Etapa 1 de 6: Negócio");
  });

  it("sem permissão: só o aviso, campo desligado", () => {
    render(ui(props({ access: { kind: "forbidden" } })));
    expect(screen.getByText(/Só quem administra a organização/)).toBeInTheDocument();
    expect(field()).toBeDisabled();
  });
});

describe("OnboardingConversationController: recomeçar a conversa", () => {
  beforeEach(() => vi.stubGlobal("sessionStorage", memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it("menu do cabeçalho → confirmação → cancela o streaming, chama o recomeço e limpa a mensagem do hero e o campo", async () => {
    saveOnboardingDraft("Tenho uma pousada", null);
    const f = streamingFetch();
    const onRestart = vi.fn(async () => ({ ok: true as const }));
    const onIntentConsumed = vi.fn();
    render(ui(props({ fetchImpl: f.fetchImpl, intent: null, onRestart, onIntentConsumed, history: loaded([msg("m1", "assistant", "Oi!")]) })));
    await userEvent.type(field(), "rascunho que não foi");
    await userEvent.click(screen.getByRole("button", { name: "Mais opções da conversa" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Recomeçar a conversa" }));
    expect(screen.getByText(/Nada foi criado no seu CRM ainda/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Recomeçar$/ }));
    await waitFor(() => expect(onRestart).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(/Nada foi criado no seu CRM ainda/)).not.toBeInTheDocument());
    expect(field().value).toBe("");
    expect(sessionStorage.getItem(ONBOARDING_DRAFT_KEY)).toBeNull();
    expect(onIntentConsumed).toHaveBeenCalled();
  });

  it("recomeço durante um turno: o stream é abortado antes", async () => {
    const f = streamingFetch();
    let aborted = false;
    const onRestart = vi.fn(async () => {
      aborted = f.mock.mock.calls[0]?.[1]?.signal?.aborted === true;
      return { ok: true as const };
    });
    render(ui(props({ fetchImpl: f.fetchImpl, onRestart })));
    await userEvent.type(field(), "tenho uma loja{Enter}");
    await waitFor(() => expect(f.mock).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "Mais opções da conversa" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Recomeçar a conversa" }));
    await userEvent.click(screen.getByRole("button", { name: /^Recomeçar$/ }));
    await waitFor(() => expect(onRestart).toHaveBeenCalled());
    expect(aborted).toBe(true);
  });

  it("falha do recomeço: mensagem do servidor na confirmação, nada some", async () => {
    const f = streamingFetch();
    const onRestart = vi.fn(async () => ({ ok: false as const, message: "Você recomeçou a conversa várias vezes em pouco tempo." }));
    render(ui(props({ fetchImpl: f.fetchImpl, onRestart, chatState: { stage: "draft", lastChips: [], applied: true } })));
    await userEvent.click(screen.getByRole("button", { name: "Mais opções da conversa" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Recomeçar a conversa" }));
    expect(screen.getByText(/o que já foi criado no seu CRM continua lá/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Recomeçar$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/várias vezes/);
  });

  it("sem onRestart: sem o menu", () => {
    render(ui(props()));
    expect(screen.queryByRole("button", { name: "Mais opções da conversa" })).not.toBeInTheDocument();
  });

  it("depois de recomeçar, foca o campo quando a conversa fica pronta", async () => {
    const { rerender } = render(ui(props({ focusComposerOnReady: true, history: { results: [], status: "LoadingFirstPage", loadMore: vi.fn() } })));
    rerender(ui(props({ focusComposerOnReady: true, history: loaded() })));
    await waitFor(() => expect(document.activeElement).toBe(field()));
  });
});
