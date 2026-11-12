import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { OnboardingConversationController, type OnboardingConversationControllerProps } from "./OnboardingConversationController";
import { CartaoContaView } from "./blocks/CartaoContaBlock";
import { AvisoMateriaisView } from "./blocks/AvisoMateriaisBlock";
import { MATERIALS_NOTICE_TEXT } from "../../../convex/lib/onboardingBlocks";

// Os blocos de conta/aviso reais usam Convex; aqui entram as Views por `renderGateBlock`.
const ack = vi.fn(async (_args: { organizationId: string | null; sessionId: string | null }) => {});
const requestCode = vi.fn(async () => ({ sent: true }));
const renderGateBlock: OnboardingConversationControllerProps["renderGateBlock"] = (gate, ctx) =>
  gate === "cartaoConta" ? (
    <CartaoContaView verified={false} onRequest={requestCode} onConfirm={async () => ({ verified: false })} />
  ) : (
    <AvisoMateriaisView
      text={MATERIALS_NOTICE_TEXT}
      acknowledged={false}
      onAck={() => ack({ organizationId: ctx.organizationId, sessionId: ctx.sessionId })}
    />
  );

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
    chatState: { stage: "interview", lastChips: [] },
    draft: null,
    token: "tok",
    intent: null,
    siteUrl: "https://x.convex.site",
    renderGateBlock,
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
    ack.mockClear();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "x", code: "notice_required" }), { status: 403 }));
    render(ui(props({ fetchImpl: fetchMock as unknown as typeof fetch, uploadFile: vi.fn() })));
    await userEvent.click(screen.getByRole("button", { name: "Enviar site, PDF ou imagem" }));
    await userEvent.click(screen.getByRole("button", { name: /Link do site ou Instagram/ }));
    await userEvent.type(screen.getByLabelText(/Endereço/), "https://loja.com.br");
    await userEvent.click(screen.getByRole("button", { name: "Enviar link" }));
    const region = await screen.findByRole("region", { name: "Aviso sobre materiais" });
    expect(ack).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Li e entendi" }));
    expect(ack).toHaveBeenCalledWith({ organizationId: "org1", sessionId: "s1" });
    expect(region).toBeInTheDocument();
  });

  it("sem e-mail confirmado: mostra o cartão de conta e NÃO sobe o arquivo nem chama o servidor", async () => {
    const fetchMock = vi.fn();
    const uploadFile = vi.fn();
    render(
      ui(
        props({
          fetchImpl: fetchMock as unknown as typeof fetch,
          uploadFile,
          chatState: { stage: "interview", lastChips: [], materialsUnlocked: false, materialsNoticeAcknowledged: true },
        })
      )
    );
    await userEvent.click(screen.getByRole("button", { name: "Enviar site, PDF ou imagem" }));
    await userEvent.upload(screen.getByLabelText("Escolher PDF"), new File(["%PDF"], "c.pdf", { type: "application/pdf" }));
    expect(await screen.findByRole("region", { name: "Confirme o seu e-mail" })).toBeInTheDocument();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sem ciência do aviso: mostra o aviso e não sobe; depois de liberado, 'Enviar de novo' sobe", async () => {
    const fetchMock = vi.fn(async () => sseResponse([{ type: "done", nextStage: null, askForMaterials: false }]));
    const uploadFile = vi.fn(async () => "st1");
    const gated = props({
      fetchImpl: fetchMock as unknown as typeof fetch,
      uploadFile,
      chatState: { stage: "interview", lastChips: [], materialsUnlocked: true, materialsNoticeAcknowledged: false },
    });
    const { rerender } = render(ui(gated));
    await userEvent.click(screen.getByRole("button", { name: "Enviar site, PDF ou imagem" }));
    await userEvent.upload(screen.getByLabelText("Escolher imagem"), new File(["a"], "f.png", { type: "image/png" }));
    expect(await screen.findByRole("region", { name: "Aviso sobre materiais" })).toBeInTheDocument();
    expect(uploadFile).not.toHaveBeenCalled();
    rerender(ui({ ...gated, chatState: { stage: "interview", lastChips: [], materialsUnlocked: true, materialsNoticeAcknowledged: true } }));
    await userEvent.click(screen.getByRole("button", { name: "Enviar de novo" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock, 0).attachment).toEqual({ kind: "image", storageId: "st1" });
  });

  it("estado do portão desconhecido (campos ausentes): não barra, o servidor decide", async () => {
    const uploadFile = vi.fn(async () => "st2");
    const fetchMock = vi.fn(async () => sseResponse([{ type: "done", nextStage: null, askForMaterials: false }]));
    render(ui(props({ fetchImpl: fetchMock as unknown as typeof fetch, uploadFile })));
    await userEvent.click(screen.getByRole("button", { name: "Enviar site, PDF ou imagem" }));
    await userEvent.upload(screen.getByLabelText("Escolher imagem"), new File(["a"], "f.png", { type: "image/png" }));
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
  });

  it("arquivo guardado na fila: se o upload falha depois da confirmação, a conversa avisa e pede para anexar de novo", async () => {
    const uploadFile = vi.fn(async () => Promise.reject(new Error("x")));
    const gated = props({
      uploadFile,
      chatState: { stage: "interview", lastChips: [], materialsUnlocked: false, materialsNoticeAcknowledged: true },
    });
    const { rerender } = render(ui(gated));
    await userEvent.click(screen.getByRole("button", { name: "Enviar site, PDF ou imagem" }));
    await userEvent.upload(screen.getByLabelText("Escolher imagem"), new File(["a"], "f.png", { type: "image/png" }));
    await screen.findByRole("region", { name: "Confirme o seu e-mail" });
    expect(screen.getByText(/Guardei f\.png aqui no seu navegador/)).toBeInTheDocument();
    rerender(ui({ ...gated, chatState: { stage: "interview", lastChips: [], materialsUnlocked: true, materialsNoticeAcknowledged: true } }));
    expect(await screen.findByText(/Não consegui enviar f\.png/)).toBeInTheDocument();
  });
});
