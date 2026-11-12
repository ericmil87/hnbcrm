import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NewsletterForm } from "./NewsletterForm";
import { COMMUNITY_COPY } from "./manifestoCopy";

describe("NewsletterForm", () => {
  it("envia e-mail, source e isca vazia; mostra o sucesso no lugar do formulário", async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<NewsletterForm source="manifesto" submit={submit} />);
    await user.type(screen.getByLabelText("Seu e-mail"), "maria@cliente.test");
    await user.click(screen.getByRole("button", { name: "Quero receber" }));
    expect(submit).toHaveBeenCalledWith({ email: "maria@cliente.test", source: "manifesto", _honeypot: "" });
    expect(await screen.findByRole("status")).toHaveTextContent(COMMUNITY_COPY.newsletter.success);
    expect(screen.queryByRole("button", { name: "Quero receber" })).toBeNull();
  });

  it("manda o nome quando preenchido e linka a política", async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<NewsletterForm source="landing" submit={submit} />);
    expect(screen.getByRole("link", { name: "Política de Privacidade" }).getAttribute("href")).toBe("/privacidade");
    await user.type(screen.getByLabelText("Seu nome (opcional)"), "Maria");
    await user.type(screen.getByLabelText("Seu e-mail"), "m@c.test");
    await user.click(screen.getByRole("button", { name: "Quero receber" }));
    expect(submit).toHaveBeenCalledWith({ email: "m@c.test", name: "Maria", source: "landing", _honeypot: "" });
  });

  it("erro aparece em role=alert e o formulário continua", async () => {
    const submit = vi.fn().mockResolvedValue({ ok: false, code: "rate_limited", message: "Muitas tentativas." });
    const user = userEvent.setup();
    render(<NewsletterForm source="landing" submit={submit} />);
    await user.type(screen.getByLabelText("Seu e-mail"), "m@c.test");
    await user.click(screen.getByRole("button", { name: "Quero receber" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Muitas tentativas.");
    expect(screen.getByRole("button", { name: "Quero receber" })).toBeTruthy();
  });

  it("não envia duas vezes enquanto carrega", async () => {
    let resolve: (v: { ok: true }) => void = () => {};
    const submit = vi.fn().mockImplementation(() => new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    render(<NewsletterForm source="landing" submit={submit} />);
    await user.type(screen.getByLabelText("Seu e-mail"), "m@c.test");
    const button = screen.getByRole("button", { name: "Quero receber" });
    await user.click(button);
    await user.click(button);
    await user.type(screen.getByLabelText("Seu e-mail"), "{Enter}");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-busy")).toBe("true");
    resolve({ ok: true });
    expect(await screen.findByRole("status")).toBeTruthy();
  });
});
