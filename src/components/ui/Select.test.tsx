import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Select } from "./Select";

const OPTIONS = [
  { value: "UTC", label: "UTC" },
  { value: "BRL", label: "BRL (R$)" },
];

function Harness({ error }: { error?: string }) {
  const [v, setV] = useState("UTC");
  return <Select label="Moeda" hint="Usada nos valores" error={error} value={v} onValueChange={setV} options={OPTIONS} />;
}

describe("Select", () => {
  it("muda o valor", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const select = screen.getByLabelText("Moeda");
    await user.selectOptions(select, "BRL");
    expect(select).toHaveValue("BRL");
  });

  it("mostra erro com aria-invalid e aria-describedby", () => {
    render(<Harness error="Escolha uma moeda" />);
    const select = screen.getByLabelText("Moeda");
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select).toHaveAccessibleDescription(/Escolha uma moeda/);
    expect(screen.getByRole("alert")).toHaveTextContent("Escolha uma moeda");
  });

  it("renderiza placeholder e grupos", () => {
    render(
      <Select
        value=""
        onValueChange={() => {}}
        placeholder="Selecione"
        groups={[{ label: "Américas", options: [{ value: "br", label: "Brasil" }] }]}
        aria-label="País"
      />
    );
    expect(screen.getByRole("option", { name: "Selecione" })).toBeDisabled();
    expect(screen.getByRole("group", { name: "Américas" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "País" })).toHaveValue("");
  });
});
