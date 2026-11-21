import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { buildTemplateDraft } from "../../../../convex/lib/schedTemplates";
import { AgendaSetupWizardView, type AgendaSetupWizardViewProps } from "./AgendaSetupWizardView";

const clinic = () => buildTemplateDraft("clinic", { members: [{ id: "m1", name: "Ana" }] });
const base = (over: Partial<AgendaSetupWizardViewProps> = {}): AgendaSetupWizardViewProps => ({
  open: true, onClose: () => {}, templateKey: "clinic", onTemplateChange: () => {}, serverDraft: clinic(), submitting: false, error: null, onApply: () => {}, ...over,
});
const next = () => fireEvent.click(screen.getByRole("button", { name: "Continuar" }));

describe("AgendaSetupWizardView", () => {
  it("caminho feliz da clínica: modelo, ajuste (4 profissionais, sala dupla com 2) e IA em 'propõe'", () => {
    const onApply = vi.fn();
    render(<AgendaSetupWizardView {...base({ onApply })} />);
    next();
    expect(screen.getByDisplayValue("Sala dupla")).toBeInTheDocument();
    for (const name of ["Bia", "Caio", "Duda"]) {
      fireEvent.click(screen.getByRole("button", { name: "Adicionar profissional" }));
      const empty = screen.getAllByLabelText(/^Profissional \d$/).find((i) => (i as HTMLInputElement).value === "")!;
      fireEvent.change(empty, { target: { value: name } });
    }
    expect(screen.getByLabelText("Resumo")).toHaveTextContent(/3 salas.*4 profissionais/s);
    next();
    expect(screen.getByRole("radio", { name: /Consulta e reserva para você aprovar/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Interpretar minhas confirmações pelo WhatsApp" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Criar minha agenda" }));
    const [draft, ai] = onApply.mock.calls[0];
    expect(draft.templateKey).toBe("clinic");
    expect(draft.resources.filter((r: { kind: string }) => r.kind === "person")).toHaveLength(4);
    expect(draft.resources.find((r: { name: string }) => r.name === "Sala dupla").capacity).toBe(2);
    expect(ai).toMatchObject({ book: "propose", humanConfirmMode: "auto", ackAcceptedNow: false });
  });

  it("'Marca sozinha' mostra o aviso e só vale depois do aceite", () => {
    const onApply = vi.fn();
    render(<AgendaSetupWizardView {...base({ onApply })} />);
    next();
    next();
    fireEvent.click(screen.getByRole("radio", { name: /Marca sozinha/ }));
    expect(screen.getByText(/A IA vai marcar horários sozinha/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Entendi, ligar" }));
    fireEvent.click(screen.getByRole("button", { name: "Criar minha agenda" }));
    expect(onApply.mock.calls[0][1]).toMatchObject({ book: "auto", ackAcceptedNow: true });
  });

  it("erro de validação segura o passo 2", () => {
    render(<AgendaSetupWizardView {...base()} />);
    next();
    fireEvent.click(screen.getByRole("button", { name: "Adicionar profissional" }));
    next();
    expect(screen.getByText("Dê um nome.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Criar minha agenda" })).not.toBeInTheDocument();
  });

  it("mostra a mensagem do servidor no último passo", () => {
    render(<AgendaSetupWizardView {...base({ error: "Este modelo já foi aplicado nesta agenda" })} />);
    next();
    next();
    expect(screen.getByRole("alert")).toHaveTextContent("já foi aplicado");
  });

  it("atualização do servidor com o assistente aberto não descarta o que foi editado", () => {
    const { rerender } = render(<AgendaSetupWizardView {...base()} />);
    next();
    fireEvent.change(screen.getByDisplayValue("Sala dupla"), { target: { value: "Sala do casal" } });
    rerender(<AgendaSetupWizardView {...base({ serverDraft: clinic() })} />);
    expect(screen.getByDisplayValue("Sala do casal")).toBeInTheDocument();
  });

  it("reabrir volta ao primeiro passo e mantém a edição; trocar de modelo recomeça", () => {
    const { rerender } = render(<AgendaSetupWizardView {...base()} />);
    next();
    fireEvent.change(screen.getByDisplayValue("Sala dupla"), { target: { value: "Sala do casal" } });
    rerender(<AgendaSetupWizardView {...base({ open: false })} />);
    rerender(<AgendaSetupWizardView {...base({ open: true })} />);
    expect(screen.getByRole("radiogroup", { name: "Como você atende?" })).toBeInTheDocument();
    next();
    expect(screen.getByDisplayValue("Sala do casal")).toBeInTheDocument();
    const barber = buildTemplateDraft("barber", { members: [{ id: "m1", name: "Ana" }] });
    rerender(<AgendaSetupWizardView {...base({ templateKey: "barber", serverDraft: barber })} />);
    expect(screen.queryByDisplayValue("Sala do casal")).not.toBeInTheDocument();
  });

  it("aviso de que a IA não foi salva depois de criar a agenda", () => {
    render(<AgendaSetupWizardView {...base({ partialNotice: "Sua agenda foi criada, mas a escolha de como a IA participa não foi salva." })} />);
    next();
    next();
    expect(screen.getByRole("status")).toHaveTextContent("agenda foi criada");
    expect(screen.queryByRole("button", { name: "Criar minha agenda" })).not.toBeInTheDocument();
  });

  it("escolher outro modelo avisa o container", () => {
    const onTemplateChange = vi.fn();
    render(<AgendaSetupWizardView {...base({ templateKey: null, serverDraft: undefined, onTemplateChange })} />);
    fireEvent.click(screen.getByRole("radio", { name: /Barbearia/ }));
    expect(onTemplateChange).toHaveBeenCalledWith("barber");
    expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
  });
});

describe("AgendaSetupWizardView: fechar com edição pendente", () => {
  it("sem edição fecha direto", () => {
    const onClose = vi.fn();
    render(<AgendaSetupWizardView {...base({ onClose })} />);
    fireEvent.click(screen.getByRole("button", { name: "Agora não" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("com edição pergunta: continuar não fecha, descartar fecha (também pelo X do cabeçalho)", () => {
    const onClose = vi.fn();
    render(<AgendaSetupWizardView {...base({ onClose })} />);
    next();
    fireEvent.change(screen.getByDisplayValue("Sala dupla"), { target: { value: "Sala do casal" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Fechar" })[0]);
    expect(screen.getByText("Descartar o que você ajustou?")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continuar ajustando" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Fechar" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Descartar e sair" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("mudar a escolha da IA também conta como edição", () => {
    const onClose = vi.fn();
    render(<AgendaSetupWizardView {...base({ onClose })} />);
    next();
    next();
    fireEvent.click(screen.getByRole("radio", { name: /Não mexe na agenda/ }));
    fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
    fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
    fireEvent.click(screen.getByRole("button", { name: "Agora não" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Descartar o que você ajustou?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continuar ajustando" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Agora não" }));
    fireEvent.click(screen.getByRole("button", { name: "Descartar e sair" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("depois de criada (aviso parcial) fecha sem perguntar", () => {
    const onClose = vi.fn();
    render(<AgendaSetupWizardView {...base({ onClose, partialNotice: "Sua agenda foi criada, mas..." })} />);
    next();
    fireEvent.change(screen.getByDisplayValue("Sala dupla"), { target: { value: "Outra" } });
    next();
    fireEvent.click(screen.getAllByRole("button", { name: "Fechar" })[0]);
    expect(screen.queryByText("Descartar o que você ajustou?")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("AgendaSetupWizardView: passo da IA sem IA ativa", () => {
  it("só o interruptor das confirmações, a explicação e o atalho; sem as opções da IA", () => {
    const onOpenAiSettings = vi.fn();
    render(<AgendaSetupWizardView {...base({ aiActive: false, onOpenAiSettings })} />);
    next();
    next();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByRole("switch", { name: "Interpretar minhas confirmações pelo WhatsApp" })).toBeChecked();
    expect(screen.getByText(/As opções de como a IA participa da agenda aparecem quando a IA da organização estiver ativa/)).toBeInTheDocument();
    expect(screen.getByText(/Sem a IA ativa ele só sugere/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Configurar a IA" }));
    expect(onOpenAiSettings).toHaveBeenCalledTimes(1);
  });
  it("o atalho com edição pendente pergunta antes de sair", () => {
    const onOpenAiSettings = vi.fn();
    render(<AgendaSetupWizardView {...base({ aiActive: false, onOpenAiSettings })} />);
    next();
    fireEvent.change(screen.getByDisplayValue("Sala dupla"), { target: { value: "Sala do casal" } });
    next();
    fireEvent.click(screen.getByRole("button", { name: "Configurar a IA" }));
    expect(onOpenAiSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Descartar e sair" }));
    expect(onOpenAiSettings).toHaveBeenCalledTimes(1);
  });
  it("com IA ativa (ou ainda carregando) mostra as três opções", () => {
    render(<AgendaSetupWizardView {...base({ aiActive: true })} />);
    next();
    next();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });
});
