import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { UnsubscribePageView, type UnsubscribePageViewProps } from "./UnsubscribePage";

function setup(props: Partial<UnsubscribePageViewProps>) {
  const onSet = vi.fn();
  render(
    <MemoryRouter>
      <UnsubscribePageView preview={undefined} busy={false} error={false} onSet={onSet} {...props} />
    </MemoryRouter>,
  );
  return onSet;
}

describe("UnsubscribePageView", () => {
  it("carregando: só o indicador, nada chamado", () => {
    const onSet = setup({});
    expect(screen.getByRole("status", { name: "Carregando" })).toBeTruthy();
    expect(onSet).not.toHaveBeenCalled();
  });

  it("válido e ligado: pergunta com a organização e chama onSet(false) ao clicar", () => {
    const onSet = setup({ preview: { valid: true, orgName: "Acme <b>x</b>", enabled: true } });
    expect(onSet).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Desativar os e-mails de cobrança e recibos do HNBCRM para Acme <b>x</b>?");
    expect(document.querySelector("b")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Desativar" }));
    expect(onSet).toHaveBeenCalledWith(false);
  });

  it("desligado: confirma, avisa dos críticos e chama onSet(true)", () => {
    const onSet = setup({ preview: { valid: true, orgName: "Acme", enabled: false } });
    expect(document.body.textContent).toContain(
      "Pronto. Você não vai mais receber esses e-mails. Os avisos de falha de pagamento continuam, porque protegem a sua conta.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reativar" }));
    expect(onSet).toHaveBeenCalledWith(true);
  });

  it.each([[{ valid: false } as const], [null]])("inválido ou sem token (%j): copy e link para entrar", (preview) => {
    setup({ preview });
    expect(document.body.textContent).toContain(
      "Este link não vale mais. Entre no HNBCRM e ajuste em Configurações › Notificações.",
    );
    expect(screen.getByRole("link", { name: "Entrar" }).getAttribute("href")).toBe("/entrar");
  });

  it("durante a mutation o botão fica desabilitado", () => {
    const onSet = setup({ preview: { valid: true, orgName: "Acme", enabled: true }, busy: true });
    const btn = screen.getByRole("button", { name: /Desativar/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onSet).not.toHaveBeenCalled();
  });

  it("erro: mostra mensagem para tentar de novo", () => {
    setup({ preview: { valid: true, orgName: "Acme", enabled: true }, error: true });
    expect(screen.getByRole("alert").textContent).toContain("Tente de novo");
  });
});
