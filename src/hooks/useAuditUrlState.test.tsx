import { describe, expect, it } from "vitest";
import { act, screen } from "@testing-library/react";
import { renderWithRouter } from "@/test/render";
import { useAuditUrlState } from "./useAuditUrlState";

function Harness() {
  const a = useAuditUrlState();
  return (
    <div>
      <output data-testid="log">{a.openLogId ?? "nada"}</output>
      <output data-testid="severity">{a.severity}</output>
      <button onClick={() => a.setOpenLog("a")}>abrir</button>
      <button onClick={() => a.setOpenLog(null)}>fechar</button>
      <button onClick={() => a.setSeverity("high")}>filtrar</button>
      <button onClick={a.clearAll}>limpar</button>
    </div>
  );
}

const click = async (name: string) => {
  await act(async () => {
    screen.getByText(name).click();
  });
};

describe("useAuditUrlState", () => {
  it("abrir → filtrar → fechar mantém o filtro", async () => {
    const { router } = renderWithRouter(<Harness />, { route: "/" });
    await click("abrir");
    await click("filtrar");
    // Filtrar recolhe o item aberto na mesma escrita.
    expect(screen.getByTestId("log")).toHaveTextContent("nada");
    expect(router.state.location.search).toBe("?severity=high");
    await click("abrir");
    await click("fechar");
    expect(screen.getByTestId("severity")).toHaveTextContent("high");
    expect(new URLSearchParams(router.state.location.search).get("severity")).toBe("high");
  });

  it("limpar filtros também recolhe o item aberto", async () => {
    const { router } = renderWithRouter(<Harness />, { route: "/?severity=high&log=a" });
    await click("limpar");
    expect(router.state.location.search).toBe("");
  });
});
