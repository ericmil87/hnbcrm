import { describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { renderWithRouter } from "@/test/render";
import { useConversationSelection } from "./useConversationSelection";

const LIST = [
  { _id: "c1", kind: "direct" },
  { _id: "c2", kind: "direct" },
];
const CONTACT_ID = "k17abcdefghijklmnopqrstuvwx";

interface HarnessProps {
  list?: readonly Record<string, any>[];
  listLoaded?: boolean;
  showArchived?: boolean;
  onSelectionChange?: () => void;
  onDraft?: (draft: string) => void;
  setShowArchived?: (archived: boolean) => void;
  expose?: (api: ReturnType<typeof useConversationSelection>) => void;
}

function Harness({
  list = LIST,
  listLoaded = true,
  showArchived = false,
  onSelectionChange = () => {},
  onDraft = () => {},
  setShowArchived = () => {},
  expose,
}: HarnessProps) {
  const selection = useConversationSelection({
    validConversations: list,
    listLoaded,
    showArchived,
    setShowArchived,
    kindFilter: "all",
    onSelectionChange,
    onDraft,
  });
  expose?.(selection);
  return (
    <div>
      <output data-testid="selected">{selection.selectedConversation ?? "nada"}</output>
      <output data-testid="messages">{String(selection.showMessages)}</output>
      <output data-testid="deeplink">{selection.deepLinkId ?? "nada"}</output>
      <output data-testid="nova">{String(selection.novaOpen)}:{selection.novaContactId ?? "-"}</output>
      <button onClick={() => selection.select("c2")}>abrir c2</button>
      <button onClick={() => selection.select("c1", { archived: null })}>abrir c1 e limpar</button>
      <button onClick={() => selection.close()}>fechar</button>
      <button onClick={() => selection.openNewConversation()}>nova</button>
      <button onClick={() => selection.closeNewConversation()}>fechar nova</button>
    </div>
  );
}

const params = (router: { state: { location: { search: string } } }) =>
  new URLSearchParams(router.state.location.search);

describe("useConversationSelection", () => {
  it("?conversation= de uma conversa da lista abre direto", () => {
    const onSelectionChange = vi.fn();
    renderWithRouter(<Harness onSelectionChange={onSelectionChange} />, { route: "/?conversation=c1" });
    expect(screen.getByTestId("selected")).toHaveTextContent("c1");
    expect(screen.getByTestId("messages")).toHaveTextContent("true");
    expect(onSelectionChange).toHaveBeenCalled();
  });

  it("espera a lista carregar antes de abrir", () => {
    renderWithRouter(<Harness listLoaded={false} />, { route: "/?conversation=c1" });
    expect(screen.getByTestId("selected")).toHaveTextContent("nada");
  });

  it("id fora da lista pede o resolver e abre quando o documento chega", async () => {
    let api!: ReturnType<typeof useConversationSelection>;
    const setShowArchived = vi.fn();
    renderWithRouter(<Harness setShowArchived={setShowArchived} expose={(a) => (api = a)} />, {
      route: "/?conversation=velha",
    });
    expect(screen.getByTestId("deeplink")).toHaveTextContent("velha");
    expect(screen.getByTestId("selected")).toHaveTextContent("nada");
    await act(async () => {
      api.handleResolveLinkedConversation({ _id: "velha", archivedAt: 5, kind: "direct" });
    });
    expect(screen.getByTestId("selected")).toHaveTextContent("velha");
    // Arquivada: a aba da lista acompanha a conversa.
    expect(setShowArchived).toHaveBeenCalledWith(true);
  });

  it("id inexistente sai da URL em silêncio e não abre nada", async () => {
    let api!: ReturnType<typeof useConversationSelection>;
    const { router } = renderWithRouter(<Harness expose={(a) => (api = a)} />, {
      route: "/?conversation=lixo&archived=1",
    });
    await act(async () => {
      api.handleResolveLinkedConversation(null);
    });
    expect(screen.getByTestId("selected")).toHaveTextContent("nada");
    expect(params(router).has("conversation")).toBe(false);
    expect(params(router).get("archived")).toBe("1");
  });

  it("abrir outra conversa limpa ?nova= na mesma escrita e não volta para a antiga", async () => {
    const { router } = renderWithRouter(<Harness />, { route: "/?conversation=c1&nova=1" });
    await act(async () => {
      screen.getByText("abrir c2").click();
    });
    expect(screen.getByTestId("selected")).toHaveTextContent("c2");
    expect(params(router).get("conversation")).toBe("c2");
    expect(params(router).has("nova")).toBe(false);
  });

  it("junta outros params na mesma escrita (aba de arquivadas)", async () => {
    const { router } = renderWithRouter(<Harness />, { route: "/?archived=1" });
    await act(async () => {
      screen.getByText("abrir c1 e limpar").click();
    });
    expect(params(router).get("conversation")).toBe("c1");
    expect(params(router).has("archived")).toBe(false);
  });

  it("voltar do navegador fecha e reabre", async () => {
    const { router } = renderWithRouter(<Harness />, { route: "/" });
    await act(async () => {
      screen.getByText("abrir c2").click();
    });
    expect(screen.getByTestId("selected")).toHaveTextContent("c2");
    await act(async () => {
      await router.navigate(-1);
    });
    expect(screen.getByTestId("selected")).toHaveTextContent("nada");
    expect(screen.getByTestId("messages")).toHaveTextContent("false");
    await act(async () => {
      await router.navigate(1);
    });
    expect(screen.getByTestId("selected")).toHaveTextContent("c2");
  });

  it("fechar limpa o param sem reabrir a conversa pela URL antiga", async () => {
    const { router } = renderWithRouter(<Harness />, { route: "/?conversation=c1" });
    expect(screen.getByTestId("selected")).toHaveTextContent("c1");
    await act(async () => {
      screen.getByText("fechar").click();
    });
    expect(screen.getByTestId("selected")).toHaveTextContent("nada");
    expect(screen.getByTestId("messages")).toHaveTextContent("false");
    expect(params(router).has("conversation")).toBe(false);
  });

  it("?nova=1 abre o modal vazio e ?nova=<contato> já com o contato; fechar limpa", async () => {
    const { router, unmount } = renderWithRouter(<Harness />, { route: "/?nova=1" });
    expect(screen.getByTestId("nova")).toHaveTextContent("true:-");
    await act(async () => {
      screen.getByText("fechar nova").click();
    });
    expect(screen.getByTestId("nova")).toHaveTextContent("false:-");
    expect(params(router).has("nova")).toBe(false);
    await act(async () => {
      screen.getByText("nova").click();
    });
    expect(params(router).get("nova")).toBe("1");
    unmount();
    renderWithRouter(<Harness />, { route: `/?nova=${CONTACT_ID}` });
    expect(screen.getByTestId("nova")).toHaveTextContent(`true:${CONTACT_ID}`);
  });

  it("rascunho de location.state entrega uma vez e limpa o state", async () => {
    const onDraft = vi.fn();
    const { router } = renderWithRouter(<Harness onDraft={onDraft} />, { route: "/?conversation=c1" });
    await act(async () => {
      await router.navigate("/?conversation=c1", { state: { draftMessage: "Olá!" } });
    });
    expect(onDraft).toHaveBeenCalledTimes(1);
    expect(onDraft).toHaveBeenCalledWith("Olá!");
    expect(router.state.location.state).toBeNull();
  });

  it("abrir e fechar pelo app volta no histórico em vez de deixar entrada morta", async () => {
    const { router } = renderWithRouter(<Harness />, { route: "/" });
    await act(async () => {
      screen.getByText("abrir c2").click();
    });
    await act(async () => {
      screen.getByText("fechar").click();
    });
    expect(screen.getByTestId("selected")).toHaveTextContent("nada");
    expect(params(router).has("conversation")).toBe(false);
    expect(router.state.historyAction).toBe("POP");
    // A entrada aberta ainda está à frente (foi voltada, não substituída).
    await act(async () => {
      await router.navigate(1);
    });
    expect(screen.getByTestId("selected")).toHaveTextContent("c2");
  });

  it("trocar de conversa substitui a entrada: um fechar volta para a lista", async () => {
    const { router } = renderWithRouter(<Harness />, { route: "/" });
    await act(async () => {
      screen.getByText("abrir c2").click();
    });
    await act(async () => {
      screen.getByText("abrir c1 e limpar").click();
    });
    expect(params(router).get("conversation")).toBe("c1");
    await act(async () => {
      screen.getByText("fechar").click();
    });
    expect(screen.getByTestId("selected")).toHaveTextContent("nada");
    expect(params(router).has("conversation")).toBe(false);
    await act(async () => {
      await router.navigate(1);
    });
    expect(screen.getByTestId("selected")).toHaveTextContent("c1");
  });

  it("deep link (entrada que não é nossa): fechar só substitui", async () => {
    const { router } = renderWithRouter(<Harness />, { route: "/?conversation=c1" });
    await act(async () => {
      screen.getByText("fechar").click();
    });
    expect(router.state.historyAction).toBe("REPLACE");
    expect(router.state.location.search).toBe("");
  });

  it("modal Nova conversa aberto pelo app: iniciar e voltar caem na lista, sem sair da tela", async () => {
    const { router } = renderWithRouter(<Harness />, { route: "/" });
    await act(async () => {
      screen.getByText("nova").click();
    });
    expect(router.state.location.search).toBe("?nova=1");
    expect(router.state.historyAction).toBe("PUSH");
    await act(async () => {
      screen.getByText("abrir c1 e limpar").click();
    });
    expect(router.state.location.search).toBe("?conversation=c1");
    expect(router.state.historyAction).toBe("REPLACE");
    await act(async () => {
      await router.navigate(-1);
    });
    expect(router.state.location.search).toBe("");
    expect(screen.getByTestId("nova")).toHaveTextContent("false:-");
    expect(screen.getByTestId("selected")).toHaveTextContent("nada");
  });

  it("fechar o modal aberto pelo app volta no histórico", async () => {
    const { router } = renderWithRouter(<Harness />, { route: "/" });
    await act(async () => {
      screen.getByText("nova").click();
    });
    await act(async () => {
      screen.getByText("fechar nova").click();
    });
    expect(router.state.location.search).toBe("");
    expect(router.state.historyAction).toBe("POP");
    expect(screen.getByTestId("nova")).toHaveTextContent("false:-");
  });

  it("close guardado de um render velho, chamado depois de voltar pelo navegador, não sai da tela", async () => {
    let api!: ReturnType<typeof useConversationSelection>;
    const { router } = renderWithRouter(<Harness expose={(a) => (api = a)} />, { route: "/" });
    await act(async () => {
      screen.getByText("abrir c2").click();
    });
    const staleClose = api.close;
    await act(async () => {
      await router.navigate(-1);
    });
    expect(router.state.location.search).toBe("");
    const before = router.state.location.key;
    await act(async () => {
      staleClose();
    });
    expect(router.state.location.search).toBe("");
    expect(router.state.location.key).toBe(before);
    expect(screen.getByTestId("selected")).toHaveTextContent("nada");
  });

  it("dois fechar seguidos voltam uma entrada só", async () => {
    const { router } = renderWithRouter(<Harness />, { route: "/" });
    await act(async () => {
      await router.navigate("/outra");
    });
    await act(async () => {
      await router.navigate("/?x=1");
    });
    await act(async () => {
      screen.getByText("abrir c2").click();
    });
    await act(async () => {
      screen.getByText("fechar").click();
      screen.getByText("fechar").click();
    });
    expect(router.state.location.pathname).toBe("/");
    expect(router.state.location.search).toBe("?x=1");
  });

  it("reabrir a conversa já aberta não cria entrada", async () => {
    const { router } = renderWithRouter(<Harness />, { route: "/?conversation=c1" });
    await act(async () => {
      screen.getByText("abrir c1 e limpar").click();
    });
    expect(router.state.historyAction).toBe("REPLACE");
  });
});
