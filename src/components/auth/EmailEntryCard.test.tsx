import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { EmailEntryCardView, type EmailEntryCardViewProps } from "./EmailEntryCard";

function setup(overrides: Partial<EmailEntryCardViewProps> = {}) {
  const props: EmailEntryCardViewProps = {
    checkEmail: vi.fn(async () => "password" as const),
    submitPassword: vi.fn(async () => {}),
    onForgotPassword: vi.fn(),
    onSuccess: vi.fn(),
    ...overrides,
  };
  const user = userEvent.setup();
  const view = render(<EmailEntryCardView {...props} />);
  return { props, user, unmount: view.unmount };
}

const emailField = () => screen.getByLabelText("E-mail");

describe("EmailEntryCardView", () => {
  it("começa com um campo só: e-mail com autocomplete e Continuar", () => {
    setup();
    expect(emailField()).toHaveAttribute("autocomplete", "email");
    expect(emailField()).toHaveAttribute("type", "email");
    expect(screen.getByRole("button", { name: "Continuar" })).toHaveAttribute("type", "submit");
    expect(screen.queryByLabelText("Senha")).toBeNull();
  });

  it("conta existente: mostra Bem-vindo de volta, senha atual e Esqueci a senha, e entra", async () => {
    const { props, user } = setup();
    await user.type(emailField(), "  Ana@Empresa.com ");
    await user.click(screen.getByRole("button", { name: "Continuar" }));

    expect(props.checkEmail).toHaveBeenCalledWith("Ana@Empresa.com");
    expect(await screen.findByRole("heading", { name: "Bem-vindo de volta" })).toBeInTheDocument();
    const password = screen.getByLabelText("Senha");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    await waitFor(() => expect(password).toHaveFocus());
    expect(screen.getByText("Ana@Empresa.com")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Esqueci a senha" }));
    expect(props.onForgotPassword).toHaveBeenCalledWith("Ana@Empresa.com");

    await user.type(password, "segredo-123");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(props.submitPassword).toHaveBeenCalledWith({
      email: "Ana@Empresa.com",
      password: "segredo-123",
      flow: "signIn",
    });
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledWith({ flow: "signIn", email: "Ana@Empresa.com" }));
  });

  it("conta nova: mostra Vamos criar sua conta, nova senha com a regra e cria", async () => {
    const { props, user } = setup({ checkEmail: vi.fn(async () => "signup" as const) });
    await user.type(emailField(), "novo@empresa.com");
    await user.click(screen.getByRole("button", { name: "Continuar" }));

    expect(await screen.findByRole("heading", { name: "Vamos criar sua conta" })).toBeInTheDocument();
    const password = screen.getByLabelText("Crie uma senha");
    expect(password).toHaveAttribute("autocomplete", "new-password");
    expect(screen.queryByRole("button", { name: "Esqueci a senha" })).toBeNull();
    // Nenhum aceite automático: o cadastro de conta não tem caixa de Termos marcada.
    expect(screen.queryByRole("checkbox")).toBeNull();

    await user.type(password, "1234567");
    await user.click(screen.getByRole("button", { name: "Criar conta" }));
    expect(screen.getByRole("alert")).toHaveTextContent("pelo menos 8 caracteres");
    expect(props.submitPassword).not.toHaveBeenCalled();

    await user.type(password, "8");
    await user.click(screen.getByRole("button", { name: "Criar conta" }));
    expect(props.submitPassword).toHaveBeenCalledWith({ email: "novo@empresa.com", password: "12345678", flow: "signUp" });
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledWith({ flow: "signUp", email: "novo@empresa.com" }));
  });

  it("Trocar e-mail volta ao primeiro passo com o e-mail preservado e focado", async () => {
    const { user } = setup();
    await user.type(emailField(), "ana@empresa.com");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    await screen.findByLabelText("Senha");
    await user.type(screen.getByLabelText("Senha"), "abc");

    await user.click(screen.getByRole("button", { name: "Trocar e-mail" }));
    expect(emailField()).toHaveValue("ana@empresa.com");
    await waitFor(() => expect(emailField()).toHaveFocus());
    expect(screen.queryByLabelText("Senha")).toBeNull();
  });

  it("valida o e-mail antes de chamar o servidor", async () => {
    const { props, user } = setup();
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Digite seu e-mail.");
    expect(emailField()).toHaveAttribute("aria-invalid", "true");

    await user.type(emailField(), "ana");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Confira o e-mail");
    expect(props.checkEmail).not.toHaveBeenCalled();
  });

  it("senha errada mostra erro claro e mantém o passo", async () => {
    const { props, user } = setup({
      submitPassword: vi.fn(async () => {
        throw new Error("Invalid credentials");
      }),
    });
    await user.type(emailField(), "ana@empresa.com");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    await user.type(await screen.findByLabelText("Senha"), "errada");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível entrar. Confira a senha ou use \"Esqueci a senha\".",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("Criar conta");
    expect(props.onSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Bem-vindo de volta" })).toBeInTheDocument();
  });

  it("mensagem do servidor no cadastro vence (conta já existente)", async () => {
    const { user } = setup({
      checkEmail: vi.fn(async () => "signup" as const),
      submitPassword: vi.fn(async () => {
        throw new ConvexError("Já existe uma conta com este e-mail. Entre ou use \"Esqueci a senha\".");
      }),
    });
    await user.type(emailField(), "ana@empresa.com");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    await user.type(await screen.findByLabelText("Crie uma senha"), "12345678");
    await user.click(screen.getByRole("button", { name: "Criar conta" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Já existe uma conta com este e-mail.");
  });

  it("checagem limitada: mensagem genérica e escolha manual do caminho", async () => {
    const { user } = setup({
      checkEmail: vi.fn(async () => {
        throw new ConvexError({ code: "rate_limited", message: "Muitas tentativas agora." });
      }),
    });
    await user.type(emailField(), "ana@empresa.com");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Muitas tentativas agora.");

    await user.click(screen.getByRole("button", { name: "Criar conta" }));
    expect(screen.getByRole("heading", { name: "Vamos criar sua conta" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Trocar e-mail" }));
    // Voltar limpa o aviso do limite.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Já tenho conta" })).toBeNull();
  });

  it("qualquer falha da checagem (rede, deploy antigo) oferece a escolha manual", async () => {
    for (const failure of [new Error("Failed to fetch"), new Error("Server Error")]) {
      const { user, unmount } = setup({
        checkEmail: vi.fn(async () => {
          throw failure;
        }),
      });
      await user.type(emailField(), "ana@empresa.com");
      await user.click(screen.getByRole("button", { name: "Continuar" }));
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Já tenho conta" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Criar conta" })).toBeInTheDocument();
      unmount();
    }
  });

  it("e-mail recusado pelo servidor não oferece a escolha manual", async () => {
    const { user } = setup({
      checkEmail: vi.fn(async () => {
        throw new ConvexError({ code: "invalid_email", message: "Digite um e-mail válido." });
      }),
    });
    await user.type(emailField(), "ana@empresa.com");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Digite um e-mail válido.");
    expect(screen.queryByRole("button", { name: "Já tenho conta" })).toBeNull();
  });

  it("entrar pela escolha manual que falha sugere voltar e criar conta", async () => {
    const { user } = setup({
      checkEmail: vi.fn(async () => {
        throw new Error("Server Error");
      }),
      submitPassword: vi.fn(async () => {
        throw new Error("Invalid credentials");
      }),
    });
    await user.type(emailField(), "ana@empresa.com");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    await user.click(await screen.findByRole("button", { name: "Já tenho conta" }));
    await user.type(screen.getByLabelText("Senha"), "qualquer");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível entrar. Confira a senha ou use \"Esqueci a senha\". Se ainda não tem conta, volte e escolha Criar conta.",
    );
  });

  it("título do primeiro passo segue ?modo=cadastro e o modo compacto mantém o fluxo", () => {
    setup({ intent: "signUp", compact: true });
    expect(screen.getByRole("heading", { name: "Crie sua conta" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continuar" })).toBeInTheDocument();
  });

  it("retorno do Esqueci a senha abre direto no passo da senha", () => {
    setup({ initialEmail: "ana@empresa.com", initialStep: "password" });
    expect(screen.getByRole("heading", { name: "Bem-vindo de volta" })).toBeInTheDocument();
  });

  it("mostrar senha alterna o tipo do campo", async () => {
    const { user } = setup();
    await user.type(emailField(), "ana@empresa.com");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    const password = await screen.findByLabelText("Senha");
    const toggle = screen.getByRole("button", { name: "Mostrar senha" });
    expect(password).toHaveAttribute("type", "password");
    await user.click(toggle);
    expect(password).toHaveAttribute("type", "text");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });
});
