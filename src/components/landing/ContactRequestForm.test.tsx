import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ContactRequestForm } from "./ContactRequestForm";
import { submitContactRequest } from "@/lib/contactRequest";
import { contactHref } from "@/lib/contactHref";

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Nome"), "Maria Teste");
  await user.type(screen.getByLabelText("E-mail"), "maria@cliente.test");
  await user.type(screen.getByLabelText(/O que você/), "Organizar o atendimento");
}

describe("ContactRequestForm", () => {
  it("envia o tipo do botão, os campos e a isca vazia; mostra a confirmação", async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<ContactRequestForm topic="consultoria" submit={submit} />);
    expect(screen.getByText(/só para entrarmos em contato/)).toBeTruthy();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Enviar pedido" }));
    expect(submit).toHaveBeenCalledWith({
      name: "Maria Teste",
      email: "maria@cliente.test",
      need: "Organizar o atendimento",
      kind: "consultoria",
      _honeypot: "",
    });
    expect(await screen.findByText(/Recebemos seu pedido/)).toBeTruthy();
  });

  it("indisponível: mostra o aviso e o e-mail como alternativa", async () => {
    const submit = vi.fn().mockResolvedValue({ ok: false, code: "unavailable", message: "O formulário está indisponível agora." });
    const user = userEvent.setup();
    render(<ContactRequestForm topic="empresa" submit={submit} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Enviar pedido" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("indisponível");
    expect(screen.getByRole("link", { name: "Enviar por e-mail" }).getAttribute("href")).toBe(contactHref("empresa"));
  });

  it("limite de pedidos também oferece o e-mail", async () => {
    const submit = vi.fn().mockResolvedValue({ ok: false, code: "rate_limited", message: "Muitos pedidos." });
    const user = userEvent.setup();
    render(<ContactRequestForm topic="implantacao" submit={submit} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Enviar pedido" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Muitos pedidos");
    expect(screen.getByRole("link", { name: "Enviar por e-mail" }).getAttribute("href")).toBe(contactHref("implantacao"));
  });
});

describe("submitContactRequest", () => {
  const input = { name: "A", email: "a@b.test", need: "x", kind: "empresa" as const };
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("200 ok", async () => {
    const f = vi.fn().mockResolvedValue(res(200, { ok: true }));
    expect(await submitContactRequest(input, f, "https://x.convex.cloud")).toEqual({ ok: true });
    expect(f.mock.calls[0][0]).toBe("https://x.convex.site/api/v1/public/contact");
  });
  it("503 unavailable vira falha com código", async () => {
    const f = vi.fn().mockResolvedValue(res(503, { ok: false, code: "unavailable", message: "x" }));
    expect(await submitContactRequest(input, f, "https://x.convex.cloud")).toMatchObject({ ok: false, code: "unavailable" });
  });
  it("sem URL ou rede caída: unavailable/error, sem lançar", async () => {
    expect(await submitContactRequest(input, vi.fn(), "")).toMatchObject({ code: "unavailable" });
    const boom = vi.fn().mockRejectedValue(new Error("rede"));
    expect(await submitContactRequest(input, boom, "https://x.convex.cloud")).toMatchObject({ code: "error" });
  });
});
