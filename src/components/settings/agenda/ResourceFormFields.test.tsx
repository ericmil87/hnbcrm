import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { newResourceForm } from "@/lib/agendaConfigForms";
import { ResourceFormFields } from "./ResourceFormFields";

describe("ResourceFormFields", () => {
  it("sala mostra 'Quantas pessoas ao mesmo tempo' com o exemplo da sala dupla", () => {
    const onChange = vi.fn();
    const value = { ...newResourceForm("room"), name: "Sala dupla" };
    render(<ResourceFormFields value={value} onChange={onChange} memberOptions={[]} />);
    expect(screen.getByLabelText("Quantas pessoas ao mesmo tempo")).toBeInTheDocument();
    expect(screen.getByText(/casal na sala dupla/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Quantas pessoas ao mesmo tempo"), { target: { value: "2" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, capacity: "2" });
  });
  it("profissional não tem capacidade, mas liga a alguém da equipe", () => {
    render(<ResourceFormFields value={newResourceForm("person")} onChange={() => {}} memberOptions={[{ value: "m1", label: "Ana" }]} />);
    expect(screen.queryByLabelText("Quantas pessoas ao mesmo tempo")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Pessoa da equipe")).toBeInTheDocument();
  });
  it("copiar horário de um dia para outros", () => {
    const onChange = vi.fn();
    render(<ResourceFormFields value={newResourceForm("room")} onChange={onChange} memberOptions={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Copiar horário de Segunda para outros dias" }));
    fireEvent.click(screen.getByRole("button", { name: "Todos os dias" }));
    fireEvent.click(screen.getByRole("button", { name: "Copiar" }));
    const next = onChange.mock.calls[0][0];
    expect(next.week[0]).toHaveLength(2);
    expect(next.week[6]).toHaveLength(2);
  });
});
