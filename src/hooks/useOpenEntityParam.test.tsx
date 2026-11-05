import { describe, expect, it } from "vitest";
import { act, screen } from "@testing-library/react";
import { renderWithRouter } from "@/test/render";
import { useOpenEntityParam } from "./useOpenEntityParam";

function Harness() {
  const { id, open, close } = useOpenEntityParam("log");
  return (
    <div>
      <output data-testid="id">{id ?? "nada"}</output>
      <button onClick={() => open("a")}>abrir a</button>
      <button onClick={() => open("b")}>abrir b</button>
      <button onClick={close}>fechar</button>
    </div>
  );
}

const click = async (name: string) => {
  await act(async () => {
    screen.getByText(name).click();
  });
};

describe("useOpenEntityParam", () => {
  it("abrir e fechar não deixam entrada morta: volta para a lista", async () => {
    const { router } = renderWithRouter(<Harness />, { route: "/?q=x" });
    await click("abrir a");
    expect(screen.getByTestId("id")).toHaveTextContent("a");
    await click("fechar");
    expect(screen.getByTestId("id")).toHaveTextContent("nada");
    expect(router.state.location.search).toBe("?q=x");
    // Uma entrada só: não há para onde voltar além da inicial.
    await click("abrir a");
    await click("fechar");
    await click("abrir b");
    await act(async () => {
      await router.navigate(-1);
    });
    expect(screen.getByTestId("id")).toHaveTextContent("nada");
  });

  it("trocar de item substitui a entrada: o voltar cai na lista", async () => {
    const { router } = renderWithRouter(<Harness />, { route: "/" });
    await click("abrir a");
    await click("abrir b");
    expect(screen.getByTestId("id")).toHaveTextContent("b");
    await act(async () => {
      await router.navigate(-1);
    });
    expect(screen.getByTestId("id")).toHaveTextContent("nada");
  });

  it("deep link (entrada que não é nossa): fechar substitui", async () => {
    const { router } = renderWithRouter(<Harness />, { route: "/?log=a" });
    await click("fechar");
    expect(screen.getByTestId("id")).toHaveTextContent("nada");
    expect(router.state.location.search).toBe("");
  });

  it("reabrir o item já aberto não cria entrada", async () => {
    const { router } = renderWithRouter(<Harness />, { route: "/" });
    await click("abrir a");
    const key = router.state.location.key;
    await click("abrir a");
    expect(router.state.location.key).toBe(key);
  });
});
