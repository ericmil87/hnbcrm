import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FormField } from "./FormField";

describe("FormField", () => {
  it("getByLabelText encontra o filho", () => {
    render(
      <FormField label="Nome" htmlFor="nome">
        <input id="nome" />
      </FormField>
    );
    expect(screen.getByLabelText("Nome")).toBeInTheDocument();
  });

  it("anuncia o erro e liga dica/erro por aria-describedby (função)", () => {
    render(
      <FormField label="E-mail" hint="Usado no login" error="Inválido">
        {(p) => <input {...p} />}
      </FormField>
    );
    const input = screen.getByLabelText("E-mail");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Inválido Usado no login");
    expect(screen.getByRole("alert")).toHaveTextContent("Inválido");
  });

  it("mostra (opcional) só quando não obrigatório e showOptional", () => {
    const { rerender } = render(
      <FormField label="Apelido" htmlFor="a" showOptional>
        <input id="a" />
      </FormField>
    );
    expect(screen.getByText("(opcional)")).toBeInTheDocument();
    rerender(
      <FormField label="Apelido" htmlFor="a" showOptional required>
        <input id="a" />
      </FormField>
    );
    expect(screen.queryByText("(opcional)")).not.toBeInTheDocument();
  });
});
