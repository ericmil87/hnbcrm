import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { OnboardingStatus } from "@/lib/onboardingWizard";
import { StepDone } from "./StepDone";

const status = (steps: Partial<OnboardingStatus["steps"]>): OnboardingStatus =>
  ({
    shouldShowWizard: true,
    accountHasEmail: true,
    capabilities: { managedBridge: true, transcription: true, llm: true, metaMessaging: false },
    steps: { business: "done", funnel: "done", whatsapp: "done", attendant: "done", test: "done", extras: "done", team: "done", ...steps },
  }) as OnboardingStatus;

const renderDone = (s: OnboardingStatus, onFinish = vi.fn()) =>
  render(
    <MemoryRouter>
      <StepDone status={s} onBack={vi.fn()} onFinish={onFinish} />
    </MemoryRouter>,
  );

describe("StepDone", () => {
  it("tudo configurado: não oferece links de configurar", () => {
    renderDone(status({}));
    expect(screen.getByText("Tudo pronto")).toBeTruthy();
    expect(screen.queryByText("Configurar")).toBeNull();
  });

  it("mostra o que falta com link para o passo e avisa do Painel", () => {
    renderDone(status({ whatsapp: "skipped", team: "pending" }));
    expect(screen.getByText("Quase lá")).toBeTruthy();
    expect(screen.getByText(/Primeiros passos/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Configurar agora: Conectar WhatsApp" });
    expect(link.getAttribute("href")).toBe("/app/configuracao-inicial?passo=whatsapp");
    expect(screen.getByText("Você pulou")).toBeTruthy();
  });

  it("Ir para o Painel chama onFinish", () => {
    const onFinish = vi.fn();
    renderDone(status({}), onFinish);
    fireEvent.click(screen.getByRole("button", { name: "Ir para o Painel" }));
    expect(onFinish).toHaveBeenCalled();
  });
});
