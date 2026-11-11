import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import {
  checkErrorView,
  convexErrorData,
  currentPasswordError,
  emailFieldError,
  flowForStep,
  newPasswordError,
  passwordStepErrorMessage,
  stepForNext,
} from "./emailEntry";

describe("emailEntry", () => {
  it("mapeia a resposta da checagem para o passo e o fluxo do provider", () => {
    expect(stepForNext("password")).toBe("password");
    expect(stepForNext("signup")).toBe("signup");
    expect(flowForStep("password")).toBe("signIn");
    expect(flowForStep("signup")).toBe("signUp");
  });

  it("valida o e-mail sem exigir a RFC inteira", () => {
    expect(emailFieldError("")).toBe("Digite seu e-mail.");
    expect(emailFieldError("   ")).toBe("Digite seu e-mail.");
    expect(emailFieldError("ana")).toMatch(/Confira o e-mail/);
    expect(emailFieldError("ana@empresa")).toMatch(/Confira o e-mail/);
    expect(emailFieldError("ana @x.com")).toMatch(/Confira o e-mail/);
    expect(emailFieldError("  Ana@Empresa.com ")).toBeNull();
  });

  it("senha: atual só não vazia; nova com o mínimo do provider", () => {
    expect(currentPasswordError("")).toBe("Digite sua senha.");
    expect(currentPasswordError("x")).toBeNull();
    expect(newPasswordError("")).toBe("Crie uma senha.");
    expect(newPasswordError("1234567")).toMatch(/pelo menos 8/);
    expect(newPasswordError("12345678")).toBeNull();
  });

  it("lê code/message do ConvexError, em objeto ou texto JSON", () => {
    expect(convexErrorData(new ConvexError({ code: "rate_limited", message: "m" }))).toEqual({
      code: "rate_limited",
      message: "m",
    });
    expect(convexErrorData(new ConvexError(JSON.stringify({ code: "x", message: "y" })))).toEqual({
      code: "x",
      message: "y",
    });
    expect(convexErrorData(new ConvexError("texto"))).toEqual({ message: "texto" });
    expect(convexErrorData(new Error("x"))).toBeNull();
  });

  it("checagem: rate limit, mensagem do servidor, rede e genérico", () => {
    expect(checkErrorView(new ConvexError({ code: "rate_limited", message: "Calma." }))).toEqual({
      message: "Calma.",
      rateLimited: true,
    });
    expect(checkErrorView(new ConvexError({ code: "invalid_email", message: "Digite um e-mail válido." }))).toEqual({
      message: "Digite um e-mail válido.",
      rateLimited: false,
    });
    expect(checkErrorView(new Error("Failed to fetch")).message).toMatch(/Sem conexão/);
    expect(checkErrorView(new Error("Server Error")).message).toBe("Não foi possível continuar. Tente de novo.");
  });

  it("passo 2: servidor vence; senha errada; senha curta; genérico", () => {
    expect(passwordStepErrorMessage(new ConvexError("Já existe uma conta com este e-mail."), "signup")).toBe(
      "Já existe uma conta com este e-mail.",
    );
    expect(passwordStepErrorMessage(new Error("Invalid credentials"), "password")).toMatch(/Senha incorreta/);
    expect(passwordStepErrorMessage(new Error("Uncaught Error: Invalid password"), "signup")).toMatch(/pelo menos 8/);
    expect(passwordStepErrorMessage(new Error("Server Error"), "signup")).toBe(
      "Não foi possível criar a conta. Tente de novo.",
    );
    expect(passwordStepErrorMessage(new Error("network down"), "password")).toMatch(/Sem conexão/);
  });
});
