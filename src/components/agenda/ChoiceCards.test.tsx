import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChoiceCards } from "./ChoiceCards";

const options = [
  { value: "a", title: "Um" },
  { value: "b", title: "Dois" },
  { value: "c", title: "Três" },
];

describe("ChoiceCards", () => {
  it("só o escolhido entra na ordem do Tab e as setas escolhem e dão a volta", () => {
    const onChange = vi.fn();
    render(<ChoiceCards label="Grupo" options={options} value="b" onChange={onChange} />);
    expect(screen.getByRole("radio", { name: /Dois/ })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: /Um/ })).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(screen.getByRole("radio", { name: /Dois/ }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("c");
    fireEvent.keyDown(screen.getByRole("radio", { name: /Dois/ }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("a");
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("c");
  });
  it("sem escolha, o primeiro é alcançável", () => {
    render(<ChoiceCards label="Grupo" options={options} value={null} onChange={() => {}} />);
    expect(screen.getByRole("radio", { name: /Um/ })).toHaveAttribute("tabindex", "0");
  });
});
