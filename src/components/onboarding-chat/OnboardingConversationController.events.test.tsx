import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { buildBlock } from "../../../convex/lib/onboardingBlocks";
import { cardSignature } from "../../../convex/lib/onboardingRoadmap";
import type { HistoryMessage } from "@/lib/onboardingChat";
import { draftFixture } from "@/test/onboardingDraftFixture";
import { BlockOverridesContext } from "./blocks/registry";
import { OnboardingConversationController, type ChatStateFacts, type OnboardingConversationControllerProps } from "./OnboardingConversationController";

const enc = new TextEncoder();

function sseResponse(events: Record<string, unknown>[]) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

const DONE = { type: "done", nextStage: null, askForMaterials: false };
const okFetch = () => vi.fn(async () => sseResponse([{ type: "delta", text: "Combinado." }, DONE]));
const bodyOf = (m: ReturnType<typeof vi.fn>, i: number) => JSON.parse((m.mock.calls[i][1] as RequestInit).body as string);

const draft = draftFixture();
const funilBlock = buildBlock(
  { kind: "funilPreview" },
  { draft, draftHash: "h", draftVersion: 1, appliedDraftHash: null, emailVerified: true, aiActive: false }
)!;

function msg(id: string, role: "user" | "assistant", text: string, blocks: unknown[] = []): HistoryMessage {
  return { _id: id, role, text, blocks, chips: [], attachment: null, createdAt: 1_800_000_000_000 };
}

const chat = (over: Partial<ChatStateFacts> = {}): ChatStateFacts => ({ stage: "interview", lastChips: [], emailVerified: true, ...over });

function props(over: Partial<OnboardingConversationControllerProps> = {}): OnboardingConversationControllerProps {
  return {
    organizationId: "org1",
    access: { kind: "ready" },
    sessionId: "s1",
    history: { results: [msg("a1", "assistant", "Este é o seu funil.", [funilBlock])], status: "Exhausted", loadMore: vi.fn() },
    chatState: chat(),
    draft,
    token: "tok",
    intent: null,
    siteUrl: "https://x.convex.site",
    renderEmailCard: () => <p>Cartão do e-mail (teste)</p>,
    ...over,
  };
}

const ui = (p: OnboardingConversationControllerProps) => (
  <MemoryRouter>
    <OnboardingConversationController {...p} />
  </MemoryRouter>
);

const field = () => screen.getByLabelText("Mensagem para o Copiloto") as HTMLTextAreaElement;
// A barra do rodapé da conversa (a do painel "Sua operação" vem depois no DOM).
const bar = () => screen.getAllByRole("group", { name: "Próximo passo" })[0];

describe("ação de cartão concluída → evento → próximo passo", () => {
  it("'Está bom, seguir' envia o approve com a seção e a assinatura; sem bolha da pessoa", async () => {
    const user = userEvent.setup();
    const fetchMock = okFetch();
    render(ui(props({ fetchImpl: fetchMock as unknown as typeof fetch })));
    await user.click(screen.getByRole("button", { name: "Está bom, seguir" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = bodyOf(fetchMock, 0);
    expect(body.event).toEqual({ kind: "approve", section: "funnel", sig: cardSignature(draft, "funilPreview") });
    expect(body.text).toBeUndefined();
    expect(body.attachment).toBeUndefined();
    await screen.findByText("Combinado.");
    // Nenhuma bolha de mensagem da pessoa foi criada.
    expect(screen.queryByText("✓")).toBeNull();
    expect(document.querySelectorAll('[data-variant="out"]').length).toBe(0);
  });

  it("aprovado ao vivo: o cartão recolhe com o selo 'Aprovado'", () => {
    render(ui(props({ chatState: chat({ approvals: { funnel: cardSignature(draft, "funilPreview") } }) })));
    const card = screen.getAllByRole("region", { name: "Vendas" })[0];
    expect(within(card).getByText("Aprovado")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Está bom, seguir" })).toBeNull();
  });

  it("evento pedido durante um turno espera e sai quando a conversa fica ociosa (não se perde)", async () => {
    const user = userEvent.setup();
    const bodies: Array<{ push: (e: Record<string, unknown>[]) => void; close: () => void }> = [];
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => {
      void init;
      let ctrl!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
      bodies.push({
        push: (events) => ctrl.enqueue(enc.encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""))),
        close: () => ctrl.close(),
      });
      return new Response(body, { status: 200 });
    });
    render(ui(props({ fetchImpl: fetchMock as unknown as typeof fetch })));
    await user.type(field(), "Oi{Enter}");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Durante o turno o botão de aprovar ainda pode ser tocado (o cartão está à vista).
    await user.click(screen.getByRole("button", { name: "Está bom, seguir" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => {
      bodies[0].push([{ type: "delta", text: "Oi!" }, DONE]);
      bodies[0].close();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bodyOf(fetchMock as unknown as ReturnType<typeof vi.fn>, 1).event).toMatchObject({ kind: "approve", section: "funnel" });
  });
});

describe("barra do próximo passo", () => {
  it("sempre visível, com o rótulo do roteiro; nada é enviado ao montar", async () => {
    const fetchMock = okFetch();
    render(ui(props({ fetchImpl: fetchMock as unknown as typeof fetch })));
    expect(within(bar()).getByRole("button", { name: /Conferir o meu funil/ })).toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("o cartão do passo é o mais recente: só rola até ele, sem pedir nada ao servidor", async () => {
    const user = userEvent.setup();
    const fetchMock = okFetch();
    render(ui(props({ fetchImpl: fetchMock as unknown as typeof fetch })));
    await user.click(within(bar()).getByRole("button", { name: /Conferir o meu funil/ }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("o cartão está mais acima (não é a última mensagem): rola até ele e o destaca, sem pedir ao servidor", async () => {
    const user = userEvent.setup();
    const fetchMock = okFetch();
    const history = { results: [msg("u1", "user", "Valeu"), msg("a1", "assistant", "Este é o seu funil.", [funilBlock])], status: "Exhausted" as const, loadMore: vi.fn() };
    render(ui(props({ fetchImpl: fetchMock as unknown as typeof fetch, history })));
    const card = document.querySelector<HTMLElement>('[data-onboarding-card="funilPreview"]')!;
    const spy = vi.fn();
    card.scrollIntoView = spy;
    await user.click(within(bar()).getByRole("button", { name: /Conferir o meu funil/ }));
    expect(card.dataset.highlight).toBe("on");
    expect(spy).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("o cartão não está na conversa: a barra pede o passo ao servidor (evento next)", async () => {
    const user = userEvent.setup();
    const fetchMock = okFetch();
    const history = { results: [msg("u1", "user", "Valeu"), msg("a1", "assistant", "Combinado.")], status: "Exhausted" as const, loadMore: vi.fn() };
    render(ui(props({ fetchImpl: fetchMock as unknown as typeof fetch, history })));
    await user.click(within(bar()).getByRole("button", { name: /Conferir o meu funil/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodyOf(fetchMock, 0).event).toEqual({ kind: "next" });
  });

  it("erro de limite no turno: a caixa mantém 'Tentar de novo' e a barra do próximo passo continua funcionando (evento sem LLM)", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Limite de uso atingido.", code: "budget" }), { status: 429 }))
      .mockImplementation(async () => sseResponse([{ type: "delta", text: "Segue." }, DONE]));
    const history = { results: [msg("u1", "user", "Valeu"), msg("a1", "assistant", "Combinado.")], status: "Exhausted" as const, loadMore: vi.fn() };
    render(ui(props({ fetchImpl: fetchMock as unknown as typeof fetch, history })));
    await user.type(field(), "Oi{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Limite de uso atingido.");
    expect(screen.getByRole("button", { name: /Tentar de novo/ })).toBeInTheDocument();
    await user.click(within(bar()).getByRole("button", { name: /Conferir o meu funil/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bodyOf(fetchMock, 1).event).toEqual({ kind: "next" });
  });

  it("sem rascunho: 'Contar sobre o meu negócio' leva ao campo", async () => {
    const user = userEvent.setup();
    render(ui(props({ draft: null, history: { results: [], status: "Exhausted", loadMore: vi.fn() } })));
    await user.click(within(bar()).getByRole("button", { name: "Contar sobre o meu negócio" }));
    expect(field()).toHaveFocus();
  });

  it("tudo pronto: o próximo passo é o link 'Abrir o meu CRM'", () => {
    render(ui(props({ chatState: chat({ aiActive: true, applied: true, tested: true, connected: true }) })));
    expect(within(bar()).getByRole("link", { name: "Abrir o meu CRM" })).toHaveAttribute("href", "/app/painel");
  });
});

describe("sugestões coerentes", () => {
  it("sugestão gravada antes de o negócio ser contado some; as coerentes ficam", () => {
    render(ui(props({ chatState: chat({ lastChips: ["Tenho uma clínica", "Quero mudar as etapas"] }), history: { results: [msg("a1", "assistant", "Oi")], status: "Exhausted", loadMore: vi.fn() } })));
    expect(screen.queryByRole("button", { name: "Tenho uma clínica" })).toBeNull();
    expect(screen.getByRole("button", { name: "Quero mudar as etapas" })).toBeInTheDocument();
  });
});

describe("e-mail: código digitado, material antes da confirmação", () => {
  const noHistory = { results: [] as HistoryMessage[], status: "Exhausted" as const, loadMore: vi.fn() };

  it("começa com o cartão compacto do e-mail (enquanto não confirmado)", () => {
    render(ui(props({ draft: null, history: noHistory, chatState: chat({ emailVerified: false, maskedEmail: "bu…te@milfont.net" }) })));
    expect(screen.getByText("Cartão do e-mail (teste)")).toBeInTheDocument();
  });

  it("exatamente 6 dígitos no campo, com o e-mail por confirmar, confirmam o código (sem mandar turno) e avisam o Copiloto", async () => {
    const user = userEvent.setup();
    const fetchMock = okFetch();
    const confirmEmailCode = vi.fn(async () => ({ verified: true }));
    render(ui(props({ draft: null, history: noHistory, fetchImpl: fetchMock as unknown as typeof fetch, confirmEmailCode, chatState: chat({ emailVerified: false }) })));
    await user.type(field(), "123456{Enter}");
    await waitFor(() => expect(confirmEmailCode).toHaveBeenCalledWith("123456"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodyOf(fetchMock, 0)).toEqual({ organizationId: "org1", sessionId: "s1", event: { kind: "notify", what: "email_verified" } });
    expect(field().value).toBe("");
  });

  it("código errado: a conversa mostra as tentativas restantes e nada é enviado", async () => {
    const user = userEvent.setup();
    const fetchMock = okFetch();
    const confirmEmailCode = vi.fn(async () => ({ verified: false, reason: "wrong" as const, attemptsLeft: 2 }));
    render(ui(props({ draft: null, history: noHistory, fetchImpl: fetchMock as unknown as typeof fetch, confirmEmailCode, chatState: chat({ emailVerified: false }) })));
    await user.type(field(), "000000{Enter}");
    expect(await screen.findByText("Código incorreto. Restam 2 tentativas.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("6 dígitos com o e-mail JÁ confirmado seguem como mensagem comum", async () => {
    const user = userEvent.setup();
    const fetchMock = okFetch();
    const confirmEmailCode = vi.fn();
    render(ui(props({ draft: null, history: noHistory, fetchImpl: fetchMock as unknown as typeof fetch, confirmEmailCode })));
    await user.type(field(), "123456{Enter}");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(confirmEmailCode).not.toHaveBeenCalled();
    expect(bodyOf(fetchMock, 0).text).toBe("123456");
  });

  it("link antes da confirmação: envia o turno normalmente (o servidor guarda e responde)", async () => {
    const fetchMock = okFetch();
    render(
      ui(props({ draft: null, history: noHistory, fetchImpl: fetchMock as unknown as typeof fetch, uploadFile: vi.fn(), chatState: chat({ emailVerified: false, materialsNoticeAcknowledged: true }) }))
    );
    await userEvent.click(screen.getByRole("button", { name: "Enviar site, PDF ou imagem" }));
    await userEvent.click(screen.getByRole("button", { name: /Link do site ou Instagram/ }));
    await userEvent.type(screen.getByLabelText(/Endereço/), "https://loja.com.br");
    await userEvent.click(screen.getByRole("button", { name: "Enviar link" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodyOf(fetchMock, 0).attachment).toEqual({ kind: "url", url: "https://loja.com.br/" });
  });

  it("arquivo antes da confirmação: não sobe, fica na fila com a bolha local; depois de confirmar, envia sozinho", async () => {
    const fetchMock = okFetch();
    const uploadFile = vi.fn(async () => "st9");
    const base = props({
      draft: null,
      history: noHistory,
      fetchImpl: fetchMock as unknown as typeof fetch,
      uploadFile,
      chatState: chat({ emailVerified: false, materialsNoticeAcknowledged: true }),
    });
    const { rerender } = render(ui(base));
    await userEvent.click(screen.getByRole("button", { name: "Enviar site, PDF ou imagem" }));
    await userEvent.upload(screen.getByLabelText("Escolher PDF"), new File(["%PDF"], "catalogo.pdf", { type: "application/pdf" }));
    expect(await screen.findByText(/Guardei catalogo\.pdf aqui no seu navegador\. Assim que você confirmar o e-mail eu leio \(mantenha esta página aberta\)\./)).toBeInTheDocument();
    expect(screen.getAllByText("Cartão do e-mail (teste)").length).toBeGreaterThan(0);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    rerender(ui({ ...base, chatState: chat({ emailVerified: true, materialsNoticeAcknowledged: true }) }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock, 0).attachment).toEqual({ kind: "pdf", storageId: "st9" });
    // Um por vez, e a fila esvazia (nenhum reenvio depois).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falta a ciência do aviso: espera o clique e só então o arquivo guardado sai", async () => {
    const fetchMock = okFetch();
    const uploadFile = vi.fn(async () => "st1");
    const base = props({
      draft: null,
      history: noHistory,
      fetchImpl: fetchMock as unknown as typeof fetch,
      uploadFile,
      renderGateBlock: (g) => <p>{g === "avisoMateriais" ? "Aviso (teste)" : "Conta (teste)"}</p>,
      chatState: chat({ emailVerified: false, materialsNoticeAcknowledged: false }),
    });
    const { rerender } = render(ui(base));
    await userEvent.click(screen.getByRole("button", { name: "Enviar site, PDF ou imagem" }));
    await userEvent.upload(screen.getByLabelText("Escolher imagem"), new File(["a"], "f.png", { type: "image/png" }));
    expect(await screen.findByText("Aviso (teste)")).toBeInTheDocument();
    rerender(ui({ ...base, chatState: chat({ emailVerified: true, materialsNoticeAcknowledged: false }) }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(uploadFile).not.toHaveBeenCalled();
    rerender(ui({ ...base, chatState: chat({ emailVerified: true, materialsNoticeAcknowledged: true }) }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});

describe("process_pending", () => {
  const history = { results: [] as HistoryMessage[], status: "Exhausted" as const, loadMore: vi.fn() };

  it("com material guardado no servidor e e-mail confirmado, dispara o evento; não repete se o número não cai; repete se cair", async () => {
    const fetchMock = okFetch();
    const base = props({ draft: null, history, fetchImpl: fetchMock as unknown as typeof fetch, chatState: chat({ pendingMaterials: 2 }) });
    const { rerender } = render(ui(base));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodyOf(fetchMock, 0).event).toEqual({ kind: "process_pending" });
    // O turno acaba e o número continua 2: trava, sem laço.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    rerender(ui({ ...base, chatState: chat({ pendingMaterials: 2, lastChips: ["x"] }) }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Caiu para 1: tenta de novo.
    rerender(ui({ ...base, chatState: chat({ pendingMaterials: 1 }) }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("com o e-mail por confirmar não dispara", async () => {
    const fetchMock = okFetch();
    render(ui(props({ draft: null, history, fetchImpl: fetchMock as unknown as typeof fetch, chatState: chat({ emailVerified: false, pendingMaterials: 1 }) })));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("teste da IA em tela dedicada", () => {
  const ready = chat({ aiActive: true, applied: true, approvals: {} });
  const screenStub = (p: import("./OnboardingConversationController").TestScreenRenderProps) => (
    <div data-testid="tela-teste">
      <p>Teste {p.tested ? "feito" : "pendente"}</p>
      <p>Sugestões: {p.suggestions.join(" | ")}</p>
      <button type="button" onClick={p.onTested}>
        Primeira resposta
      </button>
      <button type="button" onClick={p.onClose}>
        Sair do teste
      </button>
    </div>
  );

  it("a barra 'Testar a minha IA' abre a tela; a 1ª resposta marca o teste e a tela NÃO fecha (nem com mensagem nova)", async () => {
    const user = userEvent.setup();
    const fetchMock = okFetch();
    const p = props({ fetchImpl: fetchMock as unknown as typeof fetch, chatState: ready, history: { results: [msg("a1", "assistant", "Combinado.")], status: "Exhausted", loadMore: vi.fn() }, renderTestScreen: screenStub });
    const { rerender } = render(ui(p));
    await user.click(within(bar()).getByRole("button", { name: "Testar a minha IA" }));
    expect(screen.getByTestId("tela-teste")).toBeInTheDocument();
    // A conversa continua montada (escondida): nada do estado dela se perde.
    expect(screen.getByRole("log", { hidden: true })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Primeira resposta" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodyOf(fetchMock, 0).event).toEqual({ kind: "notify", what: "tested" });
    // Uma vez só.
    await user.click(screen.getByRole("button", { name: "Primeira resposta" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Chega a resposta do evento (mensagem nova + tested no servidor): a tela continua aberta.
    rerender(ui({ ...p, chatState: { ...ready, tested: true }, history: { results: [msg("a2", "assistant", "Gostou do teste?"), msg("a1", "assistant", "Combinado.")], status: "Exhausted", loadMore: vi.fn() } }));
    expect(screen.getByTestId("tela-teste")).toHaveTextContent("Teste feito");
    await user.click(screen.getByRole("button", { name: "Sair do teste" }));
    expect(screen.queryByTestId("tela-teste")).not.toBeInTheDocument();
  });

  it("as sugestões do segmento vêm do cartão final do servidor", async () => {
    const user = userEvent.setup();
    const final = { kind: "operacaoPronta", summary: { businessName: "B", funnelName: "Funil", stageCount: 3, attendantName: "Bia", knowledgeCount: 1, quickReplyCount: 0, hoursLabel: "24h" }, tested: false, connected: false, prompts: ["Quanto custa?", "Vocês abrem sábado?"] };
    render(
      <BlockOverridesContext.Provider value={{ operacaoPronta: () => <p>Cartão final</p> }}>
        {ui(props({ chatState: ready, history: { results: [msg("a1", "assistant", "Pronto.", [final])], status: "Exhausted", loadMore: vi.fn() }, renderTestScreen: screenStub }))}
      </BlockOverridesContext.Provider>
    );
    await user.click(within(bar()).getByRole("button", { name: "Testar a minha IA" }));
    expect(screen.getByTestId("tela-teste")).toHaveTextContent("Quanto custa? | Vocês abrem sábado?");
  });
});
