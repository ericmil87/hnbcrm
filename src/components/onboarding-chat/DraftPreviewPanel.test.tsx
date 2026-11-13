import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { sectionSignature } from "../../../convex/lib/onboardingRoadmap";
import { chatProgress, accountProgress } from "@/lib/onboardingChat";
import { draftFixture } from "@/test/onboardingDraftFixture";
import { DraftPreviewPanel } from "./DraftPreviewPanel";
import { StageProgress } from "./StageProgress";
import { OnboardingShowcase, SHOWCASE_STATES } from "./dev/OnboardingShowcase";

const draft = draftFixture();
const facts = { draft, approvals: {}, aiActive: false, applied: false, tested: false, connected: false, emailVerified: true };
const ctx = { organizationId: null, sessionId: null, sendText: vi.fn(), sendEvent: vi.fn(), busy: false, facts };

describe("StageProgress", () => {
  it("6 segmentos em português com a etapa atual por extenso", () => {
    render(<StageProgress progress={chatProgress({ ...facts, reachedStep: 1 })} />);
    expect(screen.getByText("Etapa 2 de 6: Funil")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuetext", "Etapa 2 de 6: Funil");
    expect(within(bar).getAllByRole("listitem")).toHaveLength(6);
    expect(within(bar).getByText(/Negócio: feito/)).toBeInTheDocument();
  });
  it("antes da conta: 'Crie a sua conta'", () => {
    render(<StageProgress progress={accountProgress()} />);
    expect(screen.getByText("Crie a sua conta")).toBeInTheDocument();
  });
});

describe("DraftPreviewPanel", () => {
  it("checklist das 6 etapas, selos por cartão e o botão do próximo passo no rodapé", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    const approvals = { funnel: sectionSignature(draft, "funnel") };
    render(
      <MemoryRouter>
        <DraftPreviewPanel
          draft={draft}
          ctx={{ ...ctx, facts: { ...facts, approvals } }}
          progress={chatProgress(facts)}
          nextStep={{ label: "Ver o jeito de atender", onPress }}
        />
      </MemoryRouter>
    );
    const list = screen.getByRole("list", { name: "Etapas da configuração" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getAllByText("Aprovado").length).toBe(1);
    expect(screen.getAllByText("Falta conferir").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /Ver o jeito de atender/ }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("vitrine de DEV do onboarding", () => {
  it.each(SHOWCASE_STATES)("estado %s renderiza sem Convex", (estado) => {
    render(
      <MemoryRouter>
        <OnboardingShowcase estado={estado} reducedMotion />
      </MemoryRouter>
    );
    expect(screen.getByRole("log")).toBeInTheDocument();
    // Sem barra do próximo passo à vista: telas de entrada (só a escolha) e a tela de teste por cima da conversa.
    if (!["escolha", "escolha-varias", "nao-admin", "teste"].includes(estado)) {
      expect(screen.getAllByRole("group", { name: "Próximo passo" }).length).toBeGreaterThan(0);
    }
  });
});
