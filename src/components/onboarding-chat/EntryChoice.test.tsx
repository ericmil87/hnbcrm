import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EntryChoiceView, type EntryChoiceViewProps } from "./EntryChoice";
import { RestartConversationDialog, restartConfirmParagraphs } from "./RestartConversationDialog";

function props(overrides: Partial<EntryChoiceViewProps> = {}): EntryChoiceViewProps {
  return {
    orgName: "Bugre Tur",
    state: "configured",
    notice: null,
    stepLabel: null,
    options: ["open_crm", "adjust", "create"],
    primary: "open_crm",
    trialNotice: "A nova empresa começa com 30 dias de teste grátis.",
    onChoose: vi.fn(),
    ...overrides,
  };
}

describe("EntryChoiceView", () => {
  it("empresa configurada: contexto, Abrir o meu CRM em primeiro e Ajustar diz que nada muda sem clique", async () => {
    const onChoose = vi.fn();
    render(<EntryChoiceView {...props({ onChoose })} />);
    expect(screen.getByText(/Você já tem o HNBCRM funcionando em/)).toBeInTheDocument();
    expect(screen.getByText("Bugre Tur")).toBeInTheDocument();
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveTextContent("Abrir o meu CRM");
    expect(screen.getByRole("button", { name: /Ajustar a operação conversando/ })).toHaveTextContent(/atendente que já existe é mantido/);
    expect(screen.getByRole("button", { name: /Criar outra empresa/ })).toHaveTextContent(/30 dias de teste/);
    await userEvent.click(screen.getByRole("button", { name: /Ajustar a operação/ }));
    expect(onChoose).toHaveBeenCalledWith("adjust");
  });

  it("conversa em andamento: diz em que etapa parou", () => {
    render(<EntryChoiceView {...props({ state: "in_progress", stepLabel: "Funil", options: ["continue", "open_crm", "create"], primary: "continue" })} />);
    expect(screen.getByText(/parou em Funil/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continuar a configuração/ })).toHaveTextContent("Você parou em: Funil.");
  });

  it("mostra a mensagem do hero antes da escolha e avisa que abrir o CRM a descarta", () => {
    render(<EntryChoiceView {...props({ intentMessage: "Tenho uma pousada em Maragogi" })} />);
    expect(screen.getByText("Você escreveu:")).toBeInTheDocument();
    expect(screen.getByText("Tenho uma pousada em Maragogi")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Abrir o meu CRM/ })).toHaveTextContent(/descartada/);
  });

  it("várias empresas: 'Para qual empresa?' lista as que administra e troca", async () => {
    const onSelectOrg = vi.fn();
    render(
      <EntryChoiceView
        {...props({
          orgs: [
            { id: "a", name: "Bugre Tur" },
            { id: "b", name: "Pousada Sol" },
          ],
          selectedOrgId: "a",
          onSelectOrg,
        })}
      />
    );
    const select = screen.getByLabelText("Para qual empresa?");
    await userEvent.selectOptions(select, "b");
    expect(onSelectOrg).toHaveBeenCalledWith("b");
  });

  it("uma empresa só: sem seletor", () => {
    render(<EntryChoiceView {...props({ orgs: [{ id: "a", name: "Bugre Tur" }], selectedOrgId: "a", onSelectOrg: vi.fn() })} />);
    expect(screen.queryByLabelText("Para qual empresa?")).not.toBeInTheDocument();
  });

  it("não administrador: explica em linguagem humana e oferece abrir o CRM ou criar a própria empresa", () => {
    render(<EntryChoiceView {...props({ variant: "not_admin", options: ["open_crm", "create"] })} />);
    expect(screen.getByText(/só quem administra a empresa pode configurar/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Criar a minha própria empresa/ })).toBeInTheDocument();
    expect(screen.queryByText(/Permissão/)).not.toBeInTheDocument();
  });

  it("modo leitura e teto: mensagem clara e próximo passo", () => {
    const { unmount } = render(<EntryChoiceView {...props({ notice: "read_only", options: ["see_plan", "open_crm", "create"], primary: "see_plan" })} />);
    expect(screen.getByText(/modo leitura/)).toBeInTheDocument();
    expect(screen.getAllByRole("button")[0]).toHaveTextContent("Ver o plano");
    unmount();
    render(<EntryChoiceView {...props({ notice: "spend_cap", options: ["see_usage", "open_crm", "create"], primary: "see_usage" })} />);
    expect(screen.getByText(/teto de gastos de IA/)).toBeInTheDocument();
    expect(screen.getAllByRole("button")[0]).toHaveTextContent("Ver o uso de IA");
  });
});

describe("RestartConversationDialog", () => {
  it("sem operação montada: diz que nada muda no CRM; confirma pelo botão", async () => {
    const onConfirm = vi.fn();
    render(<RestartConversationDialog open onClose={vi.fn()} onConfirm={onConfirm} applied={false} />);
    expect(screen.getByText(/Nada foi criado no seu CRM ainda/)).toBeInTheDocument();
    expect(screen.getByText(/aceite de IA e o e-mail confirmado continuam valendo/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Recomeçar/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("com operação montada: diz que o CRM continua e como mudar", () => {
    render(<RestartConversationDialog open onClose={vi.fn()} onConfirm={vi.fn()} applied />);
    expect(screen.getByText(/o que já foi criado no seu CRM continua lá/)).toBeInTheDocument();
    expect(restartConfirmParagraphs(true)[1]).toMatch(/Configurações/);
  });

  it("carregando e erro", () => {
    render(<RestartConversationDialog open onClose={vi.fn()} onConfirm={vi.fn()} applied={false} busy error="Você recomeçou a conversa várias vezes em pouco tempo." />);
    expect(screen.getByRole("button", { name: /Recomeçar/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/várias vezes/);
  });
});
