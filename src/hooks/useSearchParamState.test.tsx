import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import { act, screen } from "@testing-library/react";
import { renderWithRouter } from "@/test/render";
import { booleanParam, stringParam } from "@/lib/searchParamState";
import { useSearchParamState } from "./useSearchParamState";

/** Espelha o padrão do Inbox: estado local + efeito URL → estado com o guarda de escrita em voo. */
function Mirror() {
  const entity = useSearchParamState("conversation", stringParam, { history: "push" });
  const archived = useSearchParamState("archived", booleanParam);
  const [selected, setSelected] = useState<string | null>(null);
  const { value, isInFlight } = entity;

  useEffect(() => {
    if (isInFlight()) return;
    setSelected(value);
  }, [value, isInFlight]);

  return (
    <div>
      <output data-testid="selected">{selected ?? "nada"}</output>
      <output data-testid="archived">{String(archived.value)}</output>
      <button
        onClick={() => {
          setSelected("b");
          entity.set("b", { also: { nova: null } });
        }}
      >
        abrir b
      </button>
      <button
        onClick={() => {
          setSelected(null);
          entity.set(null, { history: "replace" });
        }}
      >
        fechar
      </button>
      <button onClick={() => archived.set(true)}>arquivadas</button>
    </div>
  );
}

describe("useSearchParamState", () => {
  it("lê o valor da URL inicial", () => {
    renderWithRouter(<Mirror />, { route: "/?conversation=a&archived=1" });
    expect(screen.getByTestId("selected")).toHaveTextContent("a");
    expect(screen.getByTestId("archived")).toHaveTextContent("true");
  });

  it("corrida: pedir b com a URL ainda em a não volta para a", async () => {
    const { router } = renderWithRouter(<Mirror />, { route: "/?conversation=a&nova=1" });
    await act(async () => {
      screen.getByText("abrir b").click();
    });
    expect(screen.getByTestId("selected")).toHaveTextContent("b");
    expect(new URLSearchParams(router.state.location.search).get("conversation")).toBe("b");
    // `nova` saiu na mesma escrita.
    expect(new URLSearchParams(router.state.location.search).has("nova")).toBe(false);
  });

  it("abrir usa push: o voltar do navegador reabre a anterior", async () => {
    const { router } = renderWithRouter(<Mirror />, { route: "/?conversation=a" });
    await act(async () => {
      screen.getByText("abrir b").click();
    });
    expect(screen.getByTestId("selected")).toHaveTextContent("b");
    await act(async () => {
      await router.navigate(-1);
    });
    expect(screen.getByTestId("selected")).toHaveTextContent("a");
  });

  it("filtro usa replace: não cria entrada no histórico", async () => {
    const { router } = renderWithRouter(<Mirror />, { route: "/?conversation=a" });
    const before = router.state.historyAction;
    await act(async () => {
      screen.getByText("arquivadas").click();
    });
    expect(screen.getByTestId("archived")).toHaveTextContent("true");
    expect(before).toBe("POP");
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("fechar remove o param", async () => {
    const { router } = renderWithRouter(<Mirror />, { route: "/?conversation=a" });
    await act(async () => {
      screen.getByText("fechar").click();
    });
    expect(screen.getByTestId("selected")).toHaveTextContent("nada");
    expect(router.state.location.search).toBe("");
  });

  it("replace preserva o location.state da entrada; push sem state começa limpo", async () => {
    function Writer() {
      const tab = useSearchParamState("tab", stringParam);
      const entity = useSearchParamState("item", stringParam, { history: "push" });
      return (
        <div>
          <button onClick={() => tab.set("x")}>aba</button>
          <button onClick={() => entity.set("i2")}>push</button>
          <button onClick={() => entity.set("i3", { state: { mark: 2 } })}>push marcado</button>
          <button onClick={() => tab.set("y", { state: { other: true } })}>aba com state</button>
        </div>
      );
    }
    const { router } = renderWithRouter(<Writer />, { route: "/" });
    await act(async () => {
      await router.navigate("/?item=i1", { state: { mark: 1 } });
    });
    await act(async () => {
      screen.getByText("aba").click();
    });
    expect(router.state.location.state).toEqual({ mark: 1 });
    expect(new URLSearchParams(router.state.location.search).get("tab")).toBe("x");

    await act(async () => {
      screen.getByText("push").click();
    });
    expect(router.state.location.state).toBeNull();

    await act(async () => {
      screen.getByText("push marcado").click();
    });
    expect(router.state.location.state).toEqual({ mark: 2 });

    await act(async () => {
      screen.getByText("aba com state").click();
    });
    expect(router.state.location.state).toEqual({ other: true });
  });
});
