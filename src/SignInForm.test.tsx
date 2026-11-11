import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "@/test/render";
import { SignInForm } from "./SignInForm";

vi.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signIn: vi.fn() }),
}));

describe("SignInForm", () => {
  it("abre em Entrar por padrão", () => {
    renderWithRouter(<SignInForm />);
    expect(screen.getByRole("button", { name: "Entrar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Esqueci minha senha" })).toBeTruthy();
  });

  it("abre em Cadastrar com o fluxo de cadastro (?modo=cadastro)", () => {
    renderWithRouter(<SignInForm initialFlow="signUp" />);
    const submit = screen.getByRole("button", { name: "Cadastrar" });
    expect((submit as HTMLButtonElement).type).toBe("submit");
    expect(screen.queryByRole("button", { name: "Esqueci minha senha" })).toBeNull();
  });
});
