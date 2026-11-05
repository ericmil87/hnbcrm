import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AttendantHoursForm } from "./AttendantHoursForm";

const value = { startHour: 9, endHour: 18 };

describe("AttendantHoursForm", () => {
  it("alterar início e fim chama onChange com números", () => {
    const onChange = vi.fn();
    render(<AttendantHoursForm value={value} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Início (h)"), { target: { value: "8" } });
    expect(onChange).toHaveBeenLastCalledWith({ startHour: 8, endHour: 18 });
    fireEvent.change(screen.getByLabelText("Fim (h)"), { target: { value: "20" } });
    expect(onChange).toHaveBeenLastCalledWith({ startHour: 9, endHour: 20 });
  });

  it("mostra o erro com aria-invalid", () => {
    render(<AttendantHoursForm value={value} onChange={() => {}} errors={{ endHour: "O fim precisa ser depois do início." }} />);
    expect(screen.getByLabelText("Fim (h)")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("depois do início");
  });

  it('variant="wizard" esconde a explicação', () => {
    const { rerender } = render(<AttendantHoursForm value={value} onChange={() => {}} />);
    expect(screen.getByText(/Fora dessa janela/)).toBeInTheDocument();
    rerender(<AttendantHoursForm value={value} onChange={() => {}} variant="wizard" />);
    expect(screen.queryByText(/Fora dessa janela/)).not.toBeInTheDocument();
  });

  it("Atender 24 horas esconde as horas e chama onChange com allDay", () => {
    const onChange = vi.fn();
    const { rerender } = render(<AttendantHoursForm value={value} onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch", { name: "Atender 24 horas" }));
    expect(onChange).toHaveBeenCalledWith({ ...value, allDay: true });
    rerender(<AttendantHoursForm value={{ ...value, allDay: true }} onChange={onChange} />);
    expect(screen.queryByLabelText("Início (h)")).not.toBeInTheDocument();
  });

  it("presets aplicam o horário inteiro", () => {
    const onChange = vi.fn();
    render(
      <AttendantHoursForm
        value={value}
        onChange={onChange}
        presets={[{ id: "manha", label: "Manhã", value: { startHour: 6, endHour: 12 } }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Manhã" }));
    expect(onChange).toHaveBeenCalledWith({ startHour: 6, endHour: 12 });
  });
});
