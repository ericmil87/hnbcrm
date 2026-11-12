import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CartaoContaView, type CartaoContaViewProps } from "./CartaoContaBlock";
import { CartaoAceiteView } from "./CartaoAceiteBlock";
import { AvisoMateriaisView } from "./AvisoMateriaisBlock";
import { UploadProgressoBlock } from "./UploadProgressoBlock";
import type { BlockContext } from "./types";

const ctx: BlockContext = { organizationId: "o", sessionId: "s", sendText: vi.fn(), busy: false, isLatest: true };

describe("CartaoContaView", () => {
  const base = (): CartaoContaViewProps => ({
    verified: false,
    onRequest: vi.fn(async () => ({ sent: true, canResendAt: 61_000 })),
    onConfirm: vi.fn(async () => ({ verified: false })),
  });

  it("verificado: mostra o estado e nenhum campo", () => {
    render(<CartaoContaView {...base()} verified />);
    expect(screen.getByRole("status")).toHaveTextContent("E-mail confirmado");
    expect(screen.queryByLabelText("Código de 6 dígitos")).toBeNull();
  });

  it("não envia código ao montar; só no clique, e mostra a espera para reenviar", async () => {
    const p = base();
    render(<CartaoContaView {...p} nowFn={() => 1000} />);
    expect(p.onRequest).not.toHaveBeenCalled();
    expect(screen.getByText(/liberar o envio de site, PDF, imagem e áudio/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Enviar código" }));
    expect(p.onRequest).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: /Reenviar código em/ })).toBeDisabled());
    expect(screen.getByText(/Enviamos um código de 6 dígitos/)).toBeInTheDocument();
  });

  it("campo de código: one-time-code, só dígitos, confirma com 6 dígitos", async () => {
    const p = base();
    p.onConfirm = vi.fn(async () => ({ verified: true }));
    render(<CartaoContaView {...p} />);
    const input = screen.getByLabelText("Código de 6 dígitos") as HTMLInputElement;
    expect(input).toHaveAttribute("autocomplete", "one-time-code");
    const confirm = screen.getByRole("button", { name: "Confirmar" });
    await userEvent.type(input, "12a34");
    expect(input.value).toBe("1234");
    expect(confirm).toBeDisabled();
    await userEvent.type(input, "56");
    await userEvent.click(confirm);
    expect(p.onConfirm).toHaveBeenCalledWith("123456");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("E-mail confirmado"));
  });

  it("mensagens por reason (código errado com tentativas, vencido)", async () => {
    const p = base();
    p.onConfirm = vi.fn<CartaoContaViewProps["onConfirm"]>().mockResolvedValueOnce({ verified: false, reason: "wrong", attemptsLeft: 3 }).mockResolvedValueOnce({ verified: false, reason: "expired" });
    render(<CartaoContaView {...p} />);
    await userEvent.type(screen.getByLabelText("Código de 6 dígitos"), "111111");
    await userEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(await screen.findByText("Código incorreto. Restam 3 tentativas.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(await screen.findByText("O código venceu. Peça um novo.")).toBeInTheDocument();
  });

  it("pedido recusado (rate_limited) mostra a mensagem do motivo", async () => {
    const p = base();
    p.onRequest = vi.fn(async () => ({ sent: false, reason: "rate_limited" as const }));
    render(<CartaoContaView {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "Enviar código" }));
    expect(await screen.findByText(/Muitos pedidos de código/)).toBeInTheDocument();
  });
});

describe("CartaoAceiteView", () => {
  it("nada pré-marcado; sem clique nunca chama a mutation; botão só com a caixa marcada", async () => {
    const onAccept = vi.fn(async () => {});
    render(<CartaoAceiteView active={false} onAccept={onAccept} />);
    expect(screen.getByText(/zero-retention/)).toBeInTheDocument();
    expect(screen.getByText(/LGPD, art\. 33/)).toBeInTheDocument();
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    const button = screen.getByRole("button", { name: "Ativar IA" });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onAccept).not.toHaveBeenCalled();
    await userEvent.click(box);
    await userEvent.click(button);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("status")).toHaveTextContent("A IA está ativa");
  });

  it("já ativa: mostra o estado ativo, sem botão", () => {
    render(<CartaoAceiteView active onAccept={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("ativa");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("falha da mutation mostra a mensagem e mantém o botão", async () => {
    const onAccept = vi.fn(async () => {
      throw new Error("Uncaught Error: Sem permissão");
    });
    render(<CartaoAceiteView active={false} onAccept={onAccept} />);
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Ativar IA" }));
    expect(await screen.findByText("Sem permissão")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ativar IA" })).toBeInTheDocument();
  });

  it("sem organização: desligado", () => {
    render(<CartaoAceiteView active={false} disabled onAccept={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Ativar IA" })).toBeDisabled();
  });
});

describe("AvisoMateriaisView", () => {
  it("mostra o texto do servidor e só chama a ciência no clique", async () => {
    const onAck = vi.fn(async () => {});
    render(<AvisoMateriaisView text="Texto do aviso do servidor." acknowledged={false} onAck={onAck} />);
    expect(screen.getByText("Texto do aviso do servidor.")).toBeInTheDocument();
    expect(onAck).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Li e entendi" }));
    expect(onAck).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("status")).toHaveTextContent("Ciência registrada");
  });

  it("já reconhecido: sem botão", () => {
    render(<AvisoMateriaisView text="t" acknowledged onAck={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

describe("UploadProgressoBlock", () => {
  it("lido: itens adicionados e marcados", () => {
    render(
      <UploadProgressoBlock
        ctx={ctx}
        block={{ kind: "uploadProgresso", sourceKind: "pdf", label: "catalogo.pdf", status: "lido", itemsAdded: 5, flagged: 1 }}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Li catalogo.pdf");
    expect(screen.getByText(/5 itens adicionados/)).toBeInTheDocument();
    expect(screen.getByText(/1 item marcado/)).toBeInTheDocument();
  });

  it("falhou: mensagem do servidor como texto puro, sem contagem", () => {
    const { container } = render(
      <UploadProgressoBlock
        ctx={ctx}
        block={{ kind: "uploadProgresso", sourceKind: "site", label: "loja.com", status: "falhou", itemsAdded: 0, flagged: 0, message: "<b>Site fora do ar</b>" }}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Não consegui ler loja.com");
    expect(container.textContent).toContain("Site fora do ar");
    expect(container.querySelector("b")).toBeNull();
    expect(screen.queryByText(/adicionado/)).toBeNull();
  });
});
