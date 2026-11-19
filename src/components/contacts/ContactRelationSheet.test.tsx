import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContactRelationBadge, ContactRelationSheet, NeedsRelationDialog, OffBusinessLeadWarning } from "./ContactRelationSheet";
import { ContactRelationField } from "./detail/ContactRelationField";

describe("ContactRelationSheet", () => {
  it("mostra os seis tipos com o atual marcado e a explicação", () => {
    render(<ContactRelationSheet open onClose={() => {}} name="Mieko Kawano" current="personal" onSelect={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Quem é Mieko Kawano?" })).toBeInTheDocument();
    const labels = ["Lead", "Pessoal", "Equipe", "Fornecedor", "Parceiro", "Robô"];
    for (const label of labels) expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pessoal" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Lead" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(/a IA não responde e o lead sai do funil/)).toBeInTheDocument();
  });

  it("um toque aplica e fecha, sem confirmação", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ContactRelationSheet open onClose={onClose} name="Mieko" current={undefined} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: "Fornecedor" }));
    expect(onSelect).toHaveBeenCalledWith("supplier");
    expect(onClose).toHaveBeenCalled();
  });

  it("tocar no tipo atual só fecha", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ContactRelationSheet open onClose={onClose} name="Mieko" current="team" onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: "Equipe" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("NeedsRelationDialog", () => {
  it("explica o tipo e confirma virando lead", async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <NeedsRelationDialog
        open
        onClose={onClose}
        name="Mieko"
        relation="personal"
        confirmLabel="Virar lead e devolver à IA"
        onConfirm={onConfirm}
        canEdit
      />
    );
    expect(screen.getByText("Mieko está como Pessoal. A IA não responde contatos que não são clientes.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Virar lead e devolver à IA" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("NeedsRelationDialog sem contacts:edit", () => {
  it("só explica e mostra Cancelar, sem Virar lead", () => {
    render(
      <NeedsRelationDialog
        open
        onClose={() => {}}
        name=""
        relation="team"
        confirmLabel="Virar lead e devolver à IA"
        onConfirm={() => {}}
        canEdit={false}
      />
    );
    expect(screen.getByText("Este contato está como Equipe. Peça a um admin para mudar o tipo.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Virar lead/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
  });
});

describe("ContactRelationBadge", () => {
  it("só aparece para quem não é cliente", () => {
    const { container, rerender } = render(<ContactRelationBadge relation="customer" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ContactRelationBadge relation={undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ContactRelationBadge relation="supplier" />);
    expect(screen.getByText("Fornecedor")).toBeInTheDocument();
  });
});

describe("ContactRelationField", () => {
  it("contato marcado: tipo, quem marcou e Virar lead", async () => {
    const onTurnLead = vi.fn();
    const onChangeType = vi.fn();
    render(
      <ContactRelationField
        relation="personal"
        metaLine="Marcado por Kenji em 18/11/2026 (pelo Telegram)"
        canEdit
        onChangeType={onChangeType}
        onTurnLead={onTurnLead}
      />
    );
    expect(screen.getByText("Marcado por Kenji em 18/11/2026 (pelo Telegram)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Virar lead" }));
    expect(onTurnLead).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: /Tipo de contato: Pessoal/ }));
    expect(onChangeType).toHaveBeenCalledTimes(1);
  });

  it("Lead não mostra Virar lead; sem contacts:edit só informa", () => {
    const { rerender } = render(
      <ContactRelationField relation="customer" metaLine={null} canEdit onChangeType={() => {}} onTurnLead={() => {}} />
    );
    expect(screen.queryByRole("button", { name: "Virar lead" })).not.toBeInTheDocument();
    rerender(
      <ContactRelationField relation="personal" metaLine={null} canEdit={false} onChangeType={() => {}} onTurnLead={() => {}} />
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Pessoal")).toBeInTheDocument();
  });
});

describe("OffBusinessLeadWarning", () => {
  it("avisa sem bloquear e oferece Virar lead", async () => {
    const onTurnLead = vi.fn();
    render(<OffBusinessLeadWarning relation="personal" canEdit onTurnLead={onTurnLead} />);
    expect(
      screen.getByText("Este contato está como Pessoal. Ao criar o lead ele continua sem IA. Virar lead?")
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Virar lead" }));
    expect(onTurnLead).toHaveBeenCalledTimes(1);
  });

  it("some para Lead e sem tipo; sem contacts:edit não tem botão", () => {
    const { container, rerender } = render(<OffBusinessLeadWarning relation="customer" canEdit onTurnLead={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<OffBusinessLeadWarning relation={undefined} canEdit onTurnLead={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<OffBusinessLeadWarning relation="team" canEdit={false} onTurnLead={() => {}} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
