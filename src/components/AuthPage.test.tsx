import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HelmetProvider } from "react-helmet-async";
import { renderWithRouter } from "@/test/render";
import { PLAN_KEYS } from "../../convex/lib/plans";
import { PLAN_INTENT_STORAGE_KEY, readPlanIntent } from "@/lib/authEntry";
import { AuthPage } from "./AuthPage";

// Só a borda do Convex é trocada (sessão deslogada, checagem e provider Password);
// a tela e o cartão rodam de verdade.
const checkEmail = vi.fn(async (_args: { email: string }) => ({ next: "signup" as const }));
const signIn = vi.fn(async (_provider: string, _params: Record<string, string>) => ({ signingIn: true }));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
  useMutation: () => checkEmail,
}));
vi.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signIn }),
}));

function renderAt(route: string) {
  return renderWithRouter(
    <HelmetProvider>
      <AuthPage />
    </HelmetProvider>,
    { route },
  );
}

beforeEach(() => {
  sessionStorage.clear();
  checkEmail.mockClear();
  signIn.mockClear();
});

describe("AuthPage (/entrar)", () => {
  it("sem modo: tela única de e-mail", () => {
    renderAt("/entrar");
    expect(screen.getByRole("heading", { name: "Entrar ou criar conta" })).toBeInTheDocument();
    expect(screen.getByLabelText("E-mail")).toBeInTheDocument();
  });

  it("?modo=cadastro usa a mesma tela, com o título de cadastro", () => {
    renderAt("/entrar?modo=cadastro");
    expect(screen.getByRole("heading", { name: "Crie sua conta" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continuar" })).toBeInTheDocument();
  });

  it("?plano= fica guardado do primeiro passo até depois de criar a conta", async () => {
    const plan = PLAN_KEYS[0];
    renderAt(`/entrar?modo=cadastro&plano=${plan}`);
    await waitFor(() => expect(readPlanIntent()).toBe(plan));

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("E-mail"), "novo@empresa.com");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(checkEmail).toHaveBeenCalledWith({ email: "novo@empresa.com" });

    await user.type(await screen.findByLabelText("Crie uma senha"), "12345678");
    await user.click(screen.getByRole("button", { name: "Criar conta" }));
    expect(signIn).toHaveBeenCalledWith("password", {
      email: "novo@empresa.com",
      password: "12345678",
      flow: "signUp",
    });
    // Só a criação da organização limpa o plano (OrgSwitcher).
    expect(sessionStorage.getItem(PLAN_INTENT_STORAGE_KEY)).toBe(plan);
  });

  it("?plano= inválido não é guardado", async () => {
    renderAt("/entrar?plano=nao-existe");
    await screen.findByLabelText("E-mail");
    expect(sessionStorage.getItem(PLAN_INTENT_STORAGE_KEY)).toBeNull();
  });
});
