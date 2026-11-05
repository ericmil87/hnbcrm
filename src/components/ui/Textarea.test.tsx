import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Textarea } from "./Textarea";

function Harness() {
  const [v, setV] = useState("");
  return <Textarea label="Notas" maxLength={10} value={v} onChange={(e) => setV(e.target.value)} />;
}

describe("Textarea", () => {
  it("associa o rótulo e atualiza o contador", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByText("0/10")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Notas"), "abc");
    expect(screen.getByText("3/10")).toBeInTheDocument();
  });

  it("autoGrow ajusta a altura ao conteúdo", async () => {
    const user = userEvent.setup();
    render(<Textarea aria-label="Livre" autoGrow />);
    const ta = screen.getByLabelText("Livre") as HTMLTextAreaElement;
    Object.defineProperty(ta, "scrollHeight", { configurable: true, value: 120 });
    await user.type(ta, "x");
    expect(ta.style.height).toBe("120px");
    expect(ta).toHaveClass("resize-none");
  });

  it("mostra erro com aria-invalid", () => {
    render(<Textarea label="Notas" error="Obrigatório" />);
    expect(screen.getByLabelText("Notas")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Obrigatório");
  });
});
