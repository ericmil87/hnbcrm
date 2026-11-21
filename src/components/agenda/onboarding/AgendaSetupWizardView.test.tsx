import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { buildTemplateDraft } from "../../../../convex/lib/schedTemplates";
import { AgendaSetupWizardView } from "./AgendaSetupWizardView";

const clinic = buildTemplateDraft("clinic", { members: [{ id: "m1", name: "Ana" }] });

describe("AgendaSetupWizardView", () => {
  it("caminho feliz da clínica: modelo, ajuste (4 profissionais, sala dupla com 2) e criar", () => {
    const onApply = vi.fn();
    render(
      <AgendaSetupWizardView open onClose={() => {}} templateKey="clinic" onTemplateChange={() => {}} serverDraft={clinic} submitting={false} error={null} onApply={onApply} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    expect(screen.getByDisplayValue("Sala dupla")).toBeInTheDocument();
    for (const name of ["Bia", "Caio", "Duda"]) {
      fireEvent.click(screen.getByRole("button", { name: "Adicionar profissional" }));
      const empty = screen.getAllByLabelText(/^Profissional \d$/).find((i) => (i as HTMLInputElement).value === "")!;
      fireEvent.change(empty, { target: { value: name } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    expect(screen.getByText(/3 salas/)).toBeInTheDocument();
    expect(screen.getByText(/4 profissionais/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Criar minha agenda" }));
    const draft = onApply.mock.calls[0][0];
    expect(draft.templateKey).toBe("clinic");
    expect(draft.resources.filter((r: { kind: string }) => r.kind === "person")).toHaveLength(4);
    expect(draft.resources.find((r: { name: string }) => r.name === "Sala dupla").capacity).toBe(2);
  });

  it("erro de validação segura o passo 2 e mostra a mensagem", () => {
    render(
      <AgendaSetupWizardView open onClose={() => {}} templateKey="clinic" onTemplateChange={() => {}} serverDraft={clinic} submitting={false} error={null} onApply={() => {}} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    fireEvent.click(screen.getByRole("button", { name: "Adicionar profissional" }));
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    expect(screen.getByText("Dê um nome.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Criar minha agenda" })).not.toBeInTheDocument();
  });

  it("mostra a mensagem de applied:false no último passo", () => {
    render(
      <AgendaSetupWizardView open onClose={() => {}} templateKey="clinic" onTemplateChange={() => {}} serverDraft={clinic} submitting={false} error="Sua agenda já tem serviços ou salas" onApply={() => {}} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    expect(screen.getByRole("alert")).toHaveTextContent("já tem serviços");
  });

  it("escolher outro modelo avisa o container", () => {
    const onTemplateChange = vi.fn();
    render(
      <AgendaSetupWizardView open onClose={() => {}} templateKey={null} onTemplateChange={onTemplateChange} serverDraft={undefined} submitting={false} error={null} onApply={() => {}} />
    );
    fireEvent.click(screen.getByRole("radio", { name: /Barbearia/ }));
    expect(onTemplateChange).toHaveBeenCalledWith("barber");
    expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
  });
});
