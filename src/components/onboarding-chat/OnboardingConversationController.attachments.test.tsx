import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { OnboardingConversationController, type OnboardingConversationControllerProps } from "./OnboardingConversationController";

// Só os containers dos blocos de conta/aviso (renderizados pelo portão) usam Convex.
const mutationFns = vi.hoisted(() => ({ ack: vi.fn(async () => ({})) }));
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => mutationFns.ack,
}));

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

function props(overrides: Partial<OnboardingConversationControllerProps> = {}): OnboardingConversationControllerProps {
  return {
    organizationId: "org1",
    access: { kind: "ready" },
    sessionId: "s1",
    history: { results: [], status: "Exhausted", loadMore: vi.fn() },
    sessionStage: "interview",
    chatState: { stage: "interview", lastChips: [] },
    draft: null,
    token: "tok",
    intent: null,
    siteUrl: "https://x.convex.site",
    ...overrides,
  };
}

const ui = (p: OnboardingConversationControllerProps) => (
  <MemoryRouter>
    <OnboardingConversationController {...p} />
  </MemoryRouter>
);

const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, i: number) => JSON.parse((fetchMock.mock.calls[i][1] as RequestInit).body as string);

describe("anexos no controller", () => {
  it("sem uploadFile o clipe e o microfone ficam desligados", () => {
    render(ui(props()));
    expect(screen.getByRole("button", { name: "Enviar site, PDF ou imagem" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Gravar áudio" })).toBeDisabled();
  });

  it("link: envia o turno com attachment url", async () => {
    const fetchMock = vi.fn(async () => sseResponse([{ type: "delta", text: "Lendo." }, { type: "done", nextStage: null, askForMaterials: false }]));
    render(ui(props({ fetchImpl: fetchMock as unknown as typeof fetch, uploadFile: vi.fn() })));
    await userEvent.click(screen.getByRole("button", { name: "Enviar site, PDF ou imagem" }));
    await userEvent.click(screen.getByRole("button", { name: /Link do site ou Instagram/ }));
    await userEvent.type(screen.getByLabelText(/Endereço/), "https://loja.com.br");
    await userEvent.click(screen.getByRole("button", { name: "Enviar link" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodyOf(fetchMock, 0)).toMatchObject({ organizationId: "org1", attachment: { kind: "url", url: "https://loja.com.br/" } });
    expect(bodyOf(fetchMock, 0).text).toBeUndefined();
    await waitFor(() => expect(document.body.textContent).toContain("loja.com.br"));
  });

  it("PDF: sobe primeiro e manda o storageId do upload", async () => {
    const fetchMock = vi.fn(async () => sseResponse([{ type: "done", nextStage: null, askForMaterials: false }]));
    const uploadFile = vi.fn(async (_f: unknown, onPhase: (p: "uploading" | "saving") => void) => {
      onPhase("uploading");
      return "kg2storage";
    });
    render(ui(props({ fetchImpl: fetchMock as unknown as typeof fetch, uploadFile })));
    await userEvent.click(screen.getByRole("button", { name: "Enviar site, PDF ou imagem" }));
    await userEvent.upload(screen.getByLabelText("Escolher PDF"), new File(["%PDF"], "catalogo.pdf", { type: "application/pdf" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(uploadFile).toHaveBeenCalledWith(expect.objectContaining({ name: "catalogo.pdf", mimeType: "application/pdf" }), expect.any(Function));
    expect(bodyOf(fetchMock, 0).attachment).toEqual({ kind: "pdf", storageId: "kg2storage" });
  });

  it("falha do upload: mensagem na folha e nenhum turno", async () => {
    const fetchMock = vi.fn();
    render(ui(props({ fetchImpl: fetchMock as unknown as typeof fetch, uploadFile: vi.fn(async () => Promise.reject(new Error("x"))) })));
    await userEvent.click(screen.getByRole("button", { name: "Enviar site, PDF ou imagem" }));
    await userEvent.upload(screen.getByLabelText("Escolher imagem"), new File(["a"], "f.png", { type: "image/png" }));
    expect(await screen.findByText(/Não foi possível enviar o arquivo/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("email_unverified: mostra o cartão de conta, não o erro genérico", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "x", code: "email_unverified" }), { status: 403 }));
    render(ui(props({ fetchImpl: fetchMock as unknown as typeof fetch, uploadFile: vi.fn() })));
    await userEvent.click(screen.getByRole("button", { name: "Enviar site, PDF ou imagem" }));
    await userEvent.click(screen.getByRole("button", { name: /Link do site ou Instagram/ }));
    await userEvent.type(screen.getByLabelText(/Endereço/), "https://loja.com.br");
    await userEvent.click(screen.getByRole("button", { name: "Enviar link" }));
    expect(await screen.findByRole("region", { name: "Confirme o seu e-mail" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Enviar de novo" })).toBeInTheDocument();
  });

  it("notice_required: mostra o aviso e o botão de ciência chama a mutation só no clique", async () => {
    mutationFns.ack.mockClear();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "x", code: "notice_required" }), { status: 403 }));
    render(ui(props({ fetchImpl: fetchMock as unknown as typeof fetch, uploadFile: vi.fn() })));
    await userEvent.click(screen.getByRole("button", { name: "Enviar site, PDF ou imagem" }));
    await userEvent.click(screen.getByRole("button", { name: /Link do site ou Instagram/ }));
    await userEvent.type(screen.getByLabelText(/Endereço/), "https://loja.com.br");
    await userEvent.click(screen.getByRole("button", { name: "Enviar link" }));
    const region = await screen.findByRole("region", { name: "Aviso sobre materiais" });
    expect(mutationFns.ack).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Li e entendi" }));
    expect(mutationFns.ack).toHaveBeenCalledWith({ organizationId: "org1", sessionId: "s1" });
    expect(region).toBeInTheDocument();
  });
});
