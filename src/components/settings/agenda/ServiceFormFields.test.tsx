import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { newServiceForm } from "@/lib/agendaConfigForms";
import { ServiceFormFields } from "./ServiceFormFields";

const resources = [
  { _id: "r1", name: "Sala 1", kind: "room" as const, active: true },
  { _id: "p1", name: "Ana", kind: "person" as const, active: true },
];

describe("ServiceFormFields", () => {
  it("adiciona 'Sala' como item exigido e variação", () => {
    const onChange = vi.fn();
    const value = newServiceForm();
    render(<ServiceFormFields value={value} onChange={onChange} resources={resources} />);
    fireEvent.click(screen.getByRole("button", { name: /^Sala$/ }));
    expect(onChange.mock.calls[0][0].requirements.map((r: { role: string }) => r.role)).toEqual(["Profissional", "Sala"]);
    fireEvent.click(screen.getByRole("button", { name: "Adicionar variação" }));
    expect(onChange.mock.calls[1][0].variants).toHaveLength(1);
  });
  it("duração por atalho e switch da IA", () => {
    const onChange = vi.fn();
    const value = newServiceForm();
    render(<ServiceFormFields value={value} onChange={onChange} resources={resources} />);
    fireEvent.click(screen.getByRole("button", { name: "45 min" }));
    expect(onChange.mock.calls[0][0].durationMin).toBe("45");
    fireEvent.click(screen.getByRole("switch", { name: "A IA pode oferecer este serviço" }));
    expect(onChange.mock.calls[1][0].aiBookable).toBe(false);
  });
  it("tocar no texto da linha também alterna a chave", () => {
    const onChange = vi.fn();
    render(<ServiceFormFields value={newServiceForm()} onChange={onChange} resources={resources} />);
    fireEvent.click(screen.getByText("A IA pode oferecer este serviço"));
    expect(onChange.mock.calls[0][0].aiBookable).toBe(false);
  });
  it("mostra erro do servidor-espelho", () => {
    render(<ServiceFormFields value={newServiceForm()} onChange={() => {}} resources={resources} errors={{ name: "O nome é obrigatório." }} />);
    expect(screen.getByText("O nome é obrigatório.")).toBeInTheDocument();
  });
});
