import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WIZARD_STEPS } from "@/lib/onboardingWizard";
import { OnboardingWizardV2View, WizardNav } from "./OnboardingWizardV2View";

const baseProps = {
  steps: WIZARD_STEPS,
  current: "whatsapp" as const,
  completed: ["business", "funnel"],
  onStepClick: vi.fn(),
  onDefer: vi.fn(),
};

describe("OnboardingWizardV2View", () => {
  it("mostra o indicador com 8 passos e o atual", () => {
    render(
      <OnboardingWizardV2View {...baseProps}>
        <p>conteúdo do passo</p>
      </OnboardingWizardV2View>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Configuração inicial" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByTestId("stepper-summary")).toHaveTextContent("Passo 3 de 8 · Conectar WhatsApp");
    expect(screen.getByText("conteúdo do passo")).toBeInTheDocument();
  });

  it("só passos concluídos aceitam clique", () => {
    const onStepClick = vi.fn();
    render(
      <OnboardingWizardV2View {...baseProps} onStepClick={onStepClick}>
        x
      </OnboardingWizardV2View>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Seu funil/ }));
    expect(onStepClick).toHaveBeenCalledWith("funnel");
    expect(screen.queryByRole("button", { name: /Teste/ })).toBeNull();
  });

  it("Continuar depois chama onDefer", () => {
    const onDefer = vi.fn();
    render(
      <OnboardingWizardV2View {...baseProps} onDefer={onDefer}>
        x
      </OnboardingWizardV2View>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continuar depois" }));
    expect(onDefer).toHaveBeenCalled();
  });

  it("só oferece Configurar conversando quando recebe a opção", () => {
    const { rerender } = render(<OnboardingWizardV2View {...baseProps}>x</OnboardingWizardV2View>);
    expect(screen.queryByRole("button", { name: /Configurar conversando/ })).toBeNull();
    const onToggle = vi.fn();
    rerender(
      <OnboardingWizardV2View {...baseProps} copilot={{ onToggle, open: false }}>
        x
      </OnboardingWizardV2View>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Configurar conversando/ }));
    expect(onToggle).toHaveBeenCalled();
    rerender(
      <OnboardingWizardV2View {...baseProps} copilot={{ onToggle, open: false, disabledReason: "Marque a caixa no passo 1." }}>
        x
      </OnboardingWizardV2View>,
    );
    // O Tooltip envolve o botão travado num span com role="button" (alvo da dica).
    const buttons = screen.getAllByRole("button", { name: /Configurar conversando/ });
    expect(buttons.some((b) => b.tagName === "BUTTON" && (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("mostra o aviso no topo", () => {
    render(
      <OnboardingWizardV2View {...baseProps} notice="Entre com e-mail e senha.">
        x
      </OnboardingWizardV2View>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Entre com e-mail e senha.");
  });
});

describe("WizardNav", () => {
  it("Voltar, Pular por enquanto e Continuar", () => {
    const onBack = vi.fn();
    const onSkip = vi.fn();
    const onContinue = vi.fn();
    render(<WizardNav onBack={onBack} onSkip={onSkip} onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
    fireEvent.click(screen.getByRole("button", { name: "Pular por enquanto" }));
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    expect(onBack).toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalled();
    expect(onContinue).toHaveBeenCalled();
  });

  it("sem Pular nem Voltar quando o passo não permite", () => {
    render(<WizardNav onContinue={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Voltar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pular por enquanto" })).toBeNull();
  });

  it("Continuar respeita o bloqueio", () => {
    const onContinue = vi.fn();
    render(<WizardNav onContinue={onContinue} continueDisabled />);
    expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
  });

  it("sem o recurso no servidor, Pular por enquanto é o botão principal", () => {
    render(<WizardNav onSkip={vi.fn()} skipPrimary onContinue={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Pular por enquanto" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });
});
