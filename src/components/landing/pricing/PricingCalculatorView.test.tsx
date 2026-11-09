import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithRouter } from "@/test/render";
import { calculatePricing } from "@/lib/pricing";
import { PricingCalculator } from "./PricingCalculator";
import { PricingCalculatorView, type CalculatorValue } from "./PricingCalculatorView";

const value: CalculatorValue = {
  channels: 10,
  attendances: 2000,
  byo: false,
  multiUnit: false,
  units: 2,
  groups: false,
  teamModules: false,
};

describe("PricingCalculatorView", () => {
  it("mostra o resultado em regiao status e dispara onChange", () => {
    const onChange = vi.fn();
    const result = calculatePricing({ channels: 10, aiAttendancesPerMonth: 2000, byo: false, cycle: "monthly" });
    renderWithRouter(
      <PricingCalculatorView
        value={value}
        result={result}
        examples={[{ id: "x", label: "Exemplo" }]}
        onChange={onChange}
        onPickExample={() => {}}
      />,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Escala");
    expect(status.textContent).toMatch(/R\$\s*1\.313/);
    fireEvent.click(screen.getByRole("button", { name: "Aumentar canais" }));
    expect(onChange).toHaveBeenCalledWith({ channels: 11 });
  });
});

describe("PricingCalculator", () => {
  it("exemplos de um toque batem com a tabela da decisao", () => {
    renderWithRouter(<PricingCalculator cycle="monthly" />);
    const total = () => screen.getByRole("status").textContent ?? "";
    expect(total()).toMatch(/Essencial.*R\$\s*197/);
    fireEvent.click(screen.getByRole("button", { name: "Clínica" }));
    expect(total()).toMatch(/Profissional.*R\$\s*497/);
    fireEvent.click(screen.getByRole("button", { name: "Imobiliária com 10 corretores" }));
    expect(total()).toMatch(/Escala.*R\$\s*1\.313/);
    fireEvent.click(screen.getByRole("button", { name: "Rede com 4 unidades" }));
    expect(total()).toMatch(/Empresa.*R\$\s*3\.050/);
    fireEvent.click(screen.getByRole("button", { name: "Rede com 11 unidades" }));
    expect(total()).toMatch(/Empresa.*R\$\s*5\.780/);
  });

  it("anual usa o equivalente mensal", () => {
    renderWithRouter(<PricingCalculator cycle="annual" />);
    expect(screen.getByRole("status").textContent).toMatch(/R\$\s*164/);
  });
});
