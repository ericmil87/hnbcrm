import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AttendantHoursForm } from "./AttendantHoursForm";
import { HOURS_PRESETS } from "@/lib/attendantHoursPresets";

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

  describe('variant="wizard" com presets', () => {
    const wizard = (v: Parameters<typeof AttendantHoursForm>[0]["value"], onChange = vi.fn()) => {
      render(<AttendantHoursForm value={v} onChange={onChange} variant="wizard" presets={HOURS_PRESETS} />);
      return onChange;
    };

    it("Comercial chama onChange com seg–sex, 8 às 18 e mantém o fuso", () => {
      const onChange = wizard({ allDay: true, startHour: 9, endHour: 20, timezone: "America/Manaus" });
      fireEvent.click(screen.getByRole("radio", { name: /Comercial/ }));
      expect(onChange).toHaveBeenLastCalledWith({
        allDay: false,
        startHour: 8,
        endHour: 18,
        days: [1, 2, 3, 4, 5],
        timezone: "America/Manaus",
      });
    });

    it("Sempre chama onChange com allDay", () => {
      const onChange = wizard({ startHour: 9, endHour: 18 });
      fireEvent.click(screen.getByRole("radio", { name: "Sempre" }));
      expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ allDay: true }));
    });

    it("Personalizado mostra os campos; os outros presets não", () => {
      wizard({ allDay: false, startHour: 8, endHour: 18, days: [1, 2, 3, 4, 5] });
      expect(screen.queryByLabelText("Início (h)")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("radio", { name: "Personalizado" }));
      expect(screen.getByRole("radio", { name: "Personalizado" })).toBeChecked();
      expect(screen.getByLabelText("Início (h)")).toBeInTheDocument();
    });

    it("horário que não bate com nenhum preset já abre Personalizado", () => {
      wizard({ allDay: false, startHour: 9, endHour: 17 });
      expect(screen.getByLabelText("Início (h)")).toBeInTheDocument();
      expect(screen.queryByText("Atender 24 horas")).not.toBeInTheDocument();
    });
  });
});
