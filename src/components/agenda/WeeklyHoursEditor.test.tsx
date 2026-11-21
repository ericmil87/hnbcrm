import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { weekWith } from "@/lib/agendaWeek";
import { WeeklyHoursEditor } from "./WeeklyHoursEditor";

const week = () => weekWith([1], [{ start: "09:00", end: "18:00" }]);

describe("WeeklyHoursEditor", () => {
  it("Esc na escolha de dias fecha só ela: o documento (folha/assistente por baixo) não recebe o Esc", () => {
    const onDocKey = vi.fn();
    document.addEventListener("keydown", onDocKey);
    render(<WeeklyHoursEditor value={week()} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Copiar horário de Segunda para outros dias" }));
    const group = screen.getByRole("group", { name: "Copiar horário de Segunda" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(group, { key: "Escape" });
    expect(onDocKey).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Copiar horário de Segunda" })).not.toBeInTheDocument();
    document.removeEventListener("keydown", onDocKey);
  });
  it("copia para os dias escolhidos", () => {
    const onChange = vi.fn();
    render(<WeeklyHoursEditor value={week()} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Copiar horário de Segunda para outros dias" }));
    fireEvent.click(screen.getByRole("button", { name: "Segunda a sexta" }));
    fireEvent.click(screen.getByRole("button", { name: "Copiar" }));
    expect(onChange.mock.calls[0][0][5]).toEqual([{ start: "09:00", end: "18:00" }]);
  });
  it("fim em 24:00 aparece como botão e preserva o valor", () => {
    render(<WeeklyHoursEditor value={weekWith([5], [{ start: "20:00", end: "24:00" }])} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /fim do turno 1: 24:00/ })).toHaveTextContent("24:00");
  });
});
