import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import {
  CHECK_FALLBACK_MESSAGE,
  checkErrorView,
  convexErrorData,
  currentPasswordError,
  emailFieldError,
  flowForStep,
  MANUAL_SIGN_IN_HINT,
  newPasswordError,
  passwordStepErrorMessage,
  SIGN_IN_FAILED_MESSAGE,
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

  it("checagem: escolha manual em qualquer falha, menos e-mail inválido", () => {
    expect(checkErrorView(new ConvexError({ code: "rate_limited", message: "Calma." }))).toEqual({
      message: "Calma.",
      manualChoice: true,
    });
    expect(checkErrorView(new ConvexError({ code: "invalid_email", message: "Digite um e-mail válido." }))).toEqual({
      message: "Digite um e-mail válido.",
      manualChoice: false,
    });
    const network = checkErrorView(new Error("Failed to fetch"));
    expect(network.message).toMatch(/Sem conexão/);
    expect(network.manualChoice).toBe(true);
    // OCC, função ausente num deploy antigo, erro de servidor: atalho falhou, caminho manual.
    for (const err of [
      new Error("Server Error"),
      new Error("Could not find public function for 'authEntry:checkEmailForSignIn'"),
      new ConvexError({ code: "outro", message: "x" }),
    ]) {
      expect(checkErrorView(err)).toEqual({ message: CHECK_FALLBACK_MESSAGE, manualChoice: true });
    }
  });

  it("passo 2: servidor vence; entrar falhou é neutro (+ dica na escolha manual); senha curta; genérico", () => {
    expect(passwordStepErrorMessage(new ConvexError("Já existe uma conta com este e-mail."), "signup")).toBe(
      "Já existe uma conta com este e-mail.",
    );
    expect(passwordStepErrorMessage(new Error("Invalid credentials"), "password")).toBe(SIGN_IN_FAILED_MESSAGE);
    expect(passwordStepErrorMessage(new Error("Invalid credentials"), "password", { manual: true })).toBe(
      `${SIGN_IN_FAILED_MESSAGE} ${MANUAL_SIGN_IN_HINT}`,
    );
    expect(SIGN_IN_FAILED_MESSAGE).toBe("Não foi possível entrar. Confira a senha ou use \"Esqueci a senha\".");
    expect(MANUAL_SIGN_IN_HINT).toBe("Se ainda não tem conta, volte e escolha Criar conta.");
    expect(passwordStepErrorMessage(new Error("Uncaught Error: Invalid password"), "signup")).toMatch(/pelo menos 8/);
    expect(passwordStepErrorMessage(new Error("Server Error"), "signup")).toBe(
      "Não foi possível criar a conta. Tente de novo.",
    );
    expect(passwordStepErrorMessage(new Error("network down"), "password")).toMatch(/Sem conexão/);
  });
});
