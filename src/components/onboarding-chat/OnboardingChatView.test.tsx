import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "@/test/render";
import { EmailEntryCardView } from "@/components/auth/EmailEntryCard";
import { OnboardingChatView, type OnboardingChatViewProps } from "./OnboardingChatView";
import { AI_PROCESSING_NOTICE } from "@/lib/onboardingChat";
import { SignedOutIntro } from "./ConversationIntro";

const noop = () => {};

function props(overrides: Partial<OnboardingChatViewProps> = {}): OnboardingChatViewProps {
  return {
    stage: "interview",
    timeline: [],
    typing: false,
    chips: [],
    onChip: noop,
    composerValue: "",
    onComposerChange: noop,
    onSubmit: noop,
    blockCtx: { organizationId: null, sessionId: null, sendText: noop, busy: false },
    formHref: "/app/configuracao-inicial",
    ...overrides,
  };
}

describe("OnboardingChatView", () => {
  it("sem login: mostra a mensagem do hero, o cartão de conta na conversa e a etapa 1", () => {
    renderWithRouter(
      <OnboardingChatView
        {...props({
          stage: "account",
          composerDisabled: true,
          composerPlaceholder: "Entre na sua conta para continuar",
          intro: (
            <SignedOutIntro
              intentMessage="Tenho uma clínica de estética"
              accountCard={
                <EmailEntryCardView compact checkEmail={vi.fn(async () => "signup" as const)} submitPassword={vi.fn()} onForgotPassword={noop} />
              }
            />
          ),
        })}
      />
    );
    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("Tenho uma clínica de estética")).toBeInTheDocument();
    expect(screen.getByText(/não perder o que você já contou/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Entrar ou criar conta" })).toBeInTheDocument();
    expect(screen.getByLabelText("E-mail")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "Etapa 1 de 7: Conta");
    expect(screen.getByLabelText("Mensagem para o Copiloto")).toBeDisabled();
    // Aviso de IA sempre visível, inclusive sem login e antes do primeiro envio.
    expect(screen.getByRole("note")).toHaveTextContent(AI_PROCESSING_NOTICE);
  });

  it("o aviso de IA aparece também com a conversa pronta", () => {
    renderWithRouter(<OnboardingChatView {...props()} />);
    expect(screen.getByRole("note")).toHaveTextContent(AI_PROCESSING_NOTICE);
  });

  it("anexo e microfone ficam prontos e desligados; formulário leva ao wizard", () => {
    renderWithRouter(<OnboardingChatView {...props()} />);
    expect(screen.getByRole("button", { name: "Enviar site, PDF ou imagem" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Gravar áudio" })).toBeDisabled();
    expect(screen.getByRole("link", { name: /Prefiro preencher um formulário/ })).toHaveAttribute("href", "/app/configuracao-inicial");
  });

  it("com appHref oferece a saída para o CRM; sem ele não mostra", () => {
    const { unmount } = renderWithRouter(<OnboardingChatView {...props({ appHref: "/app" })} />);
    expect(screen.getByRole("link", { name: "Ir para o CRM" })).toHaveAttribute("href", "/app");
    unmount();
    renderWithRouter(<OnboardingChatView {...props()} />);
    expect(screen.queryByRole("link", { name: "Ir para o CRM" })).toBeNull();
  });

  it("chips do rodapé enviam o texto", async () => {
    const user = userEvent.setup();
    const onChip = vi.fn();
    renderWithRouter(<OnboardingChatView {...props({ chips: ["Tenho uma clínica"], onChip })} />);
    await user.click(screen.getByRole("button", { name: "Tenho uma clínica" }));
    expect(onChip).toHaveBeenCalledWith("Tenho uma clínica");
  });

  it("digitando: status no cabeçalho, sem chips; erro com Tentar de novo", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderWithRouter(
      <OnboardingChatView
        {...props({ typing: true, status: "Lendo o site…", chips: ["A"], error: "Muitas mensagens.", onRetry })}
      />
    );
    expect(screen.getAllByText("Lendo o site…").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "A" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Muitas mensagens.");
    await user.click(screen.getByRole("button", { name: /Tentar de novo/ }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("histórico: bolhas da pessoa e do Copiloto com blocos; prévia só como painel extra", () => {
    renderWithRouter(
      <OnboardingChatView
        {...props({
          timeline: [
            { key: "u1", role: "user", text: "Oi", blocks: [], chips: [] },
            {
              key: "a1",
              role: "assistant",
              text: "Montei um funil.",
              blocks: [{ kind: "funilPreview", funnelName: "Vendas", stages: [{ name: "Novo", outcome: "open" }], customFields: [], blockedCount: 0 }],
              chips: [],
            },
          ],
          preview: <p>Prévia</p>,
        })}
      />
    );
    expect(screen.getByText("Oi")).toBeInTheDocument();
    expect(screen.getByText("Montei um funil.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Vendas" })).toBeInTheDocument();
    expect(screen.getByText("Prévia")).toBeInTheDocument();
  });
});
