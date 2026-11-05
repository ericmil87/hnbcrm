import { describe, expect, it } from "vitest";
import { act, screen } from "@testing-library/react";
import { renderWithRouter } from "@/test/render";
import { useSearchParamState } from "./useSearchParamState";
import { stringParam } from "@/lib/searchParamState";
import { useContactSelection } from "./useContactSelection";

function Harness() {
  const selection = useContactSelection();
  const search = useSearchParamState("q", stringParam);
  return (
    <div>
      <output data-testid="id">{selection.contactId ?? "nada"}</output>
      <button onClick={() => selection.open("c1")}>abrir c1</button>
      <button onClick={() => selection.open("c2")}>abrir c2</button>
      <button onClick={selection.close}>fechar</button>
      <button onClick={selection.clearInvalid}>limpar</button>
      <button onClick={() => search.set("ana")}>buscar</button>
    </div>
  );
}

const click = (text: string) => act(async () => { screen.getByText(text).click(); });
const url = (router: { state: { location: { pathname: string; search: string } } }) =>
  router.state.location.pathname + router.state.location.search;

async function setup() {
  const view = renderWithRouter(<Harness />, { route: "/app/contatos" });
  return view.router;
}

describe("useContactSelection", () => {
  it("abrir empilha; buscar com o painel aberto mantém a marca; fechar volta uma entrada", async () => {
    const router = await setup();
    await click("abrir c1");
    expect(url(router)).toBe("/app/contatos?contact=c1");
    await click("buscar");
    expect(router.state.location.state).toEqual({ contactPushed: true });
    await click("fechar");
    await act(async () => {});
    expect(url(router)).toBe("/app/contatos");
  });

  it("trocar de contato substitui a entrada e limpa contactTab", async () => {
    const router = await setup();
    await act(async () => {
      await router.navigate("/app/contatos?contact=c1&contactTab=leads", { state: { contactPushed: true } });
    });
    await click("abrir c2");
    expect(url(router)).toBe("/app/contatos?contact=c2");
    expect(router.state.location.state).toEqual({ contactPushed: true });
  });

  it("fechar depois de o navegador já ter voltado não sai da página", async () => {
    const router = await setup();
    await click("abrir c1");
    await act(async () => {
      await router.navigate(-1);
    });
    expect(url(router)).toBe("/app/contatos");
    await click("fechar");
    await act(async () => {});
    expect(url(router)).toBe("/app/contatos");
  });

  it("deep link (sem marca): fechar faz replace", async () => {
    const router = await setup();
    await act(async () => {
      await router.navigate("/app/contatos?contact=c9&contactTab=groups");
    });
    await click("fechar");
    expect(url(router)).toBe("/app/contatos");
  });

  it("navegar para outra tela sem fechar pelo histórico termina na URL nova", async () => {
    const router = await setup();
    await click("abrir c1");
    // "Conversar no WhatsApp": o painel não chama close (onNavigateAway é no-op) e só navega.
    await act(async () => {
      await router.navigate("/app/entrada?conversation=k1");
    });
    expect(url(router)).toBe("/app/entrada?conversation=k1");
  });

  it("clearInvalid remove o param com replace, sem nova entrada", async () => {
    const router = await setup();
    await act(async () => {
      await router.navigate("/app/contatos?contact=lixo");
    });
    const before = router.state.historyAction;
    await click("limpar");
    expect(url(router)).toBe("/app/contatos");
    expect(before).toBe("PUSH");
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("fechar, avançar e fechar de novo ainda fecha", async () => {
    const router = await setup();
    await click("abrir c1");
    await click("fechar");
    await act(async () => {});
    expect(url(router)).toBe("/app/contatos");
    await act(async () => {
      await router.navigate(1);
    });
    expect(url(router)).toBe("/app/contatos?contact=c1");
    await click("fechar");
    await act(async () => {});
    expect(url(router)).toBe("/app/contatos");
  });
});
