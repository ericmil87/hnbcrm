import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PhoneImportTriageView, rowsForFilter, type ExistingMatch } from "./PhoneImportTriageView";
import { buildTriageRows, initialChoices, type TriageChoice } from "@/lib/phoneContactsTriage";

const { rows } = buildTriageRows(
  [
    { fullName: "Mãe", phones: [{ value: "81999990001", types: ["cell"] }], emails: [] },
    { fullName: "Carlos Cliente", phones: [{ value: "81999990002", types: ["cell"] }], emails: [] },
    { fullName: "Distribuidora X", phones: [], emails: [{ value: "x@ex.com", types: [] }] },
  ],
  "55",
);

function renderView(overrides: Partial<Parameters<typeof PhoneImportTriageView>[0]> = {}) {
  const props = {
    rows,
    choices: initialChoices(rows) as Record<string, TriageChoice | undefined>,
    onChoose: vi.fn(),
    existing: new Map<string, ExistingMatch>([[rows[2].key, { contactId: "c1", name: null, relation: "supplier", hasOpenLead: true }]]),
    matching: null,
    createLeads: false,
    onCreateLeadsChange: vi.fn(),
    canChangeLeads: true,
    useAgendaNames: false,
    onUseAgendaNamesChange: vi.fn(),
    maxRows: 5000,
    submitting: false,
    onSubmit: vi.fn(),
    onRestart: vi.fn(),
    ...overrides,
  };
  render(<PhoneImportTriageView {...props} />);
  return props;
}

describe("PhoneImportTriageView", () => {
  it("mostra sugestão de família, quem já está no CRM e o total que vai entrar", () => {
    renderView();
    expect(screen.getByText("Sugestão")).toBeInTheDocument();
    expect(screen.getByText("Já no CRM · Fornecedor")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Importar 1 contato/ })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Criar lead no funil para quem for Lead" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("selecionar todos + ação em massa chama onChoose com as linhas do filtro", async () => {
    const props = renderView();
    expect(screen.getByRole("button", { name: "Como Lead" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Selecionar todos (3)" }));
    await userEvent.click(screen.getByRole("button", { name: "Como Equipe" }));
    expect(props.onChoose).toHaveBeenCalledWith(rows.map((r) => r.key), "team");
  });

  it("tocar na linha seleciona só ela", async () => {
    const props = renderView();
    await userEvent.click(screen.getByText("Carlos Cliente"));
    await userEvent.click(screen.getByRole("button", { name: "Não importar" }));
    expect(props.onChoose).toHaveBeenCalledWith([rows[1].key], "skip");
  });

  it("sem permissão de editar todos os leads: criar lead desligado e aviso", () => {
    renderView({ canChangeLeads: false, createLeads: true });
    expect(screen.getByRole("switch", { name: "Criar lead no funil para quem for Lead" })).toBeDisabled();
    expect(screen.getByText(/mantêm o tipo atual/)).toBeInTheDocument();
    expect(screen.getByText("Tem lead aberto")).toBeInTheDocument();
  });

  it("nada escolhido: botão de importar desligado", () => {
    renderView({ choices: {} });
    expect(screen.getByRole("button", { name: /Importar 0 contato/ })).toBeDisabled();
  });
});

describe("rowsForFilter", () => {
  it("filtra por estado", () => {
    const choices: Record<string, TriageChoice> = { [rows[0].key]: "personal", [rows[1].key]: "skip" };
    const existing = new Map<string, ExistingMatch>([[rows[2].key, { contactId: "c", name: null, relation: null, hasOpenLead: false }]]);
    expect(rowsForFilter(rows, "pending", choices, existing).map((r) => r.key)).toEqual([rows[2].key]);
    expect(rowsForFilter(rows, "family", choices, existing).map((r) => r.key)).toEqual([rows[0].key]);
    expect(rowsForFilter(rows, "existing", choices, existing).map((r) => r.key)).toEqual([rows[2].key]);
    expect(rowsForFilter(rows, "chosen", choices, existing).map((r) => r.key)).toEqual([rows[0].key]);
    expect(rowsForFilter(rows, "skip", choices, existing).map((r) => r.key)).toEqual([rows[1].key]);
  });
});
