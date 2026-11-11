import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { renderWithRouter } from "@/test/render";
import { calculatePricing } from "@/lib/pricing";
import { attendancesToSlider, sliderToAttendances, valueToInput } from "@/lib/pricingConversation";
import { PricingCalculator } from "./PricingCalculator";
import { PricingCalculatorView, type CalculatorValue } from "./PricingCalculatorView";

const base: CalculatorValue = {
  channels: 1,
  attendances: 100,
  byo: false,
  multiUnit: false,
  units: 2,
  groups: false,
  teamModules: false,
};

const originalMatchMedia = window.matchMedia;

function setReducedMotion(reduced: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduced && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = originalMatchMedia;
});

/** Deixa a contagem terminar e o anúncio assentar. */
function settle() {
  act(() => {
    vi.advanceTimersByTime(1500);
  });
}

const announced = () => screen.getByRole("status").textContent ?? "";
const slider = () => screen.getByRole("slider") as HTMLInputElement;
const people = () => screen.getByLabelText("Ou digite") as HTMLInputElement;

describe("PricingCalculatorView", () => {
  it("anuncia o plano e o preço numa região status e dispara onChange no stepper", () => {
    const onChange = vi.fn();
    const value = { ...base, channels: 10, attendances: 2000 };
    const result = calculatePricing(valueToInput(value, "monthly"));
    renderWithRouter(<PricingCalculatorView value={value} result={result} onChange={onChange} />);
    expect(announced()).toMatch(/Plano sugerido: Escala, R\$\s*1\.313 por mês\./);
    fireEvent.click(screen.getByRole("button", { name: "Aumentar números de WhatsApp" }));
    expect(onChange).toHaveBeenCalledWith({ channels: 11 });
    fireEvent.click(screen.getByRole("button", { name: "Diminuir números de WhatsApp" }));
    expect(onChange).toHaveBeenCalledWith({ channels: 9 });
  });

  it("frase principal, link do botão com o plano e aviso do excedente", () => {
    const result = calculatePricing(valueToInput(base, "monthly"));
    renderWithRouter(<PricingCalculatorView value={base} result={result} onChange={() => {}} />);
    const box = screen.getByTestId("calculator-result");
    expect(box.textContent).toMatch(/Para você:\s*Essencial,\s*R\$\s*197\/mês\./);
    expect(box.textContent).toContain("O excedente só é cobrado se você ligar");
    const link = screen.getByRole("link", { name: "Testar 30 dias grátis" });
    expect(link.getAttribute("href")).toBe("/entrar?modo=cadastro&plano=essencial");
  });

  it("com excedente a frase traz o valor estimado; Empresa vira Falar com a gente", () => {
    const over = { ...base, attendances: 400 };
    const r1 = calculatePricing(valueToInput({ ...over, byo: true }, "monthly"));
    const { unmount } = renderWithRouter(<PricingCalculatorView value={over} result={r1} onChange={() => {}} />);
    if (r1.overageAttendances > 0) {
      expect(screen.getByTestId("calculator-result").textContent).toContain("já com o excedente estimado de");
    }
    unmount();
    const emp = { ...base, multiUnit: true, units: 4 };
    const r2 = calculatePricing(valueToInput(emp, "monthly"));
    renderWithRouter(<PricingCalculatorView value={emp} result={r2} onChange={() => {}} />);
    const link = screen.getByRole("link", { name: "Falar com a gente" });
    expect(link.getAttribute("href")).toContain("plano=empresa");
  });

  it("mostra o ponto de virada para o próximo plano", () => {
    const value = { ...base, attendances: 300 };
    const result = calculatePricing(valueToInput(value, "monthly"));
    expect(result.upgradePlan).not.toBeNull();
    renderWithRouter(<PricingCalculatorView value={value} result={result} onChange={() => {}} />);
    const text = screen.getByTestId("calculator-result").textContent ?? "";
    expect(text).toMatch(/Se passar de [\d.]+ pessoas por mês, o\s*\S+ passa a sair mais barato\./);
  });

  it("some a linha por pessoa com poucas pessoas e aparece com a franquia usada", () => {
    const low = calculatePricing(valueToInput(base, "monthly"));
    const { rerender } = renderWithRouter(<PricingCalculatorView value={base} result={low} onChange={() => {}} />);
    expect(screen.getByTestId("calculator-result").textContent).not.toContain("por pessoa atendida");
    const full = { ...base, attendances: 1000 };
    const r = calculatePricing(valueToInput(full, "monthly"));
    rerender(<div />);
    renderWithRouter(<PricingCalculatorView value={full} result={r} onChange={() => {}} />);
    expect(screen.getByTestId("calculator-result").textContent).toMatch(/Dá R\$\s*0,50 por pessoa atendida/);
  });

  it("variante compacta: só perguntas 1 e 2, frase, botão e link da tabela", () => {
    const result = calculatePricing(valueToInput(base, "monthly"));
    renderWithRouter(
      <PricingCalculatorView value={base} result={result} onChange={() => {}} variant="compact" />,
    );
    expect(slider()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aumentar números de WhatsApp" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Grupos de WhatsApp" })).toBeNull();
    expect(screen.queryByText("Ver a conta")).toBeNull();
    expect(screen.getByRole("link", { name: "Testar 30 dias grátis" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ajustar mais opções" }).getAttribute("href")).toBe("/precos#calculadora");
  });

  it("slider e campo andam juntos (campo vazio vira dica sem inventar valor)", () => {
    renderWithRouter(<PricingCalculator cycle="monthly" />);
    expect(people().value).toBe("100");
    fireEvent.change(slider(), { target: { value: String(attendancesToSlider(1000)) } });
    expect(people().value).toBe("1000");
    fireEvent.change(people(), { target: { value: "2500" } });
    expect(slider().value).toBe(String(attendancesToSlider(2500)));
    // um passo à frente (o que a seta do teclado faz) muda o valor
    fireEvent.change(slider(), { target: { value: String(Number(slider().value) + 1) } });
    expect(people().value).toBe(String(sliderToAttendances(attendancesToSlider(2500) + 1)));
    expect(people().value).not.toBe("2500");
    fireEvent.click(screen.getByRole("button", { name: "5.000 pessoas ou mais" }));
    expect(people().value).toBe("5000");
    expect(slider().value).toBe(String(attendancesToSlider(5000)));
    fireEvent.change(people(), { target: { value: "" } });
    expect(people().value).toBe("");
    fireEvent.blur(people());
    expect(people().value).toBe("");
    expect(screen.getByText("Digite um número ou use a barra.")).toBeInTheDocument();
    fireEvent.change(people(), { target: { value: "300" } });
    expect(screen.queryByText("Digite um número ou use a barra.")).toBeNull();
    expect(slider().value).toBe(String(attendancesToSlider(300)));
  });

  it("normaliza o texto na hora quando diverge do valor do cálculo (zeros e teto)", () => {
    renderWithRouter(<PricingCalculator cycle="monthly" />);
    fireEvent.change(people(), { target: { value: "0450" } });
    expect(people().value).toBe("450");
    fireEvent.change(people(), { target: { value: "99999" } });
    expect(people().value).toBe("20000");
  });

  it("anúncio inclui excedente estimado e o ciclo anual", () => {
    const value = { ...base, attendances: 400 };
    const result = calculatePricing(valueToInput(value, "annual"));
    expect(result.overageAttendances).toBeGreaterThan(0);
    renderWithRouter(<PricingCalculatorView value={value} result={result} cycle="annual" onChange={() => {}} />);
    expect(announced()).toMatch(/já com excedente estimado de R\$/);
    expect(announced()).toContain("no plano anual");
  });
});

describe("PricingCalculator", () => {
  it("exemplos de um toque batem com a tabela da decisão", () => {
    renderWithRouter(<PricingCalculator cycle="monthly" />);
    settle();
    expect(announced()).toMatch(/Essencial, R\$\s*197/);
    const pick = (name: string) => {
      fireEvent.click(screen.getByRole("button", { name }));
      settle();
    };
    pick("Clínica");
    expect(announced()).toMatch(/Profissional, R\$\s*497/);
    pick("Imobiliária com 10 corretores");
    expect(announced()).toMatch(/Escala, R\$\s*1\.313/);
    pick("Rede com 4 unidades");
    expect(announced()).toMatch(/Empresa, R\$\s*3\.050/);
    pick("Rede com 11 unidades");
    expect(announced()).toMatch(/Empresa, R\$\s*5\.780/);
  });

  it("anual usa o equivalente mensal", () => {
    renderWithRouter(<PricingCalculator cycle="annual" />);
    expect(announced()).toMatch(/R\$\s*164/);
  });

  it("stepper de números muda o resultado e respeita limites", () => {
    renderWithRouter(<PricingCalculator cycle="monthly" />);
    const dec = screen.getByRole("button", { name: "Diminuir números de WhatsApp" });
    expect(dec).toBeDisabled();
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "Aumentar números de WhatsApp" }));
    settle();
    expect(screen.getByRole("group", { name: "Números de WhatsApp" }).textContent).toContain("4");
    const expected = calculatePricing(valueToInput({ ...base, channels: 4 }, "monthly"));
    expect(announced()).toContain(`Plano sugerido: ${expected.plan === "profissional" ? "Profissional" : "Escala"}`);
  });

  it("chips alteram o resultado conforme a lógica existente", () => {
    renderWithRouter(<PricingCalculator cycle="monthly" />);
    const chip = (name: string) => screen.getByRole("button", { name });
    expect(chip("Grupos de WhatsApp")).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(chip("Grupos de WhatsApp"));
    settle();
    const groups = calculatePricing(valueToInput({ ...base, groups: true }, "monthly"));
    expect(chip("Grupos de WhatsApp")).toHaveAttribute("aria-pressed", "true");
    expect(announced()).toMatch(new RegExp(`${groups.plan === "essencial" ? "Essencial" : "Profissional"}, R\\$\\s*${groups.totalMonthlyBrl}`));

    fireEvent.click(chip("Setores, tradução ou API"));
    settle();
    const team = calculatePricing(valueToInput({ ...base, groups: true, teamModules: true }, "monthly"));
    expect(team.plan).toBe("profissional");
    expect(announced()).toContain("Profissional");

    fireEvent.click(chip("Várias unidades (filiais, casas, hotéis)"));
    settle();
    expect(announced()).toContain("Empresa");
    expect(screen.getByText("Quantas unidades?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Aumentar unidades" }));
    settle();
    const emp = calculatePricing(valueToInput({ ...base, groups: true, teamModules: true, multiUnit: true, units: 3 }, "monthly"));
    expect(announced()).toMatch(new RegExp(`Empresa, R\\$\\s*${String(emp.totalMonthlyBrl).replace(/(\d)(?=(\d{3})+$)/, "$1\\.")}`));

    fireEvent.click(chip("Tenho chave de IA própria"));
    expect(chip("Tenho chave de IA própria")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/O excedente fica mais barato do Profissional em diante\./)).toBeInTheDocument();
  });

  it("avisa quando os números não cabem no plano das pessoas", () => {
    renderWithRouter(<PricingCalculator cycle="monthly" />);
    for (let i = 0; i < 9; i++) fireEvent.click(screen.getByRole("button", { name: "Aumentar números de WhatsApp" }));
    expect(screen.getByText(/Com 10 números, o Essencial não comporta\. Mostramos o plano que comporta\./)).toBeInTheDocument();
  });

  it("variante compacta mantém o mesmo cálculo", () => {
    renderWithRouter(<PricingCalculator cycle="monthly" variant="compact" fullTableHref="/precos" />);
    fireEvent.click(screen.getByRole("button", { name: "1.000 pessoas" }));
    settle();
    expect(announced()).toMatch(/Profissional, R\$\s*497/);
  });
});

describe("contagem do preço", () => {
  const profResult = calculatePricing(valueToInput({ ...base, attendances: 1000 }, "monthly"));
  const essResult = calculatePricing(valueToInput(base, "monthly"));

  function mount(value: CalculatorValue, result: typeof essResult) {
    const router = (v: CalculatorValue, r: typeof essResult) =>
      createMemoryRouter([
        { path: "*", element: <PricingCalculatorView value={v} result={r} onChange={() => {}} /> },
      ]);
    const utils = render(<RouterProvider router={router(value, result)} />);
    return {
      swap: (v: CalculatorValue, r: typeof essResult) => utils.rerender(<RouterProvider router={router(v, r)} />),
    };
  }

  it("conta até o valor final e termina exatamente nele", () => {
    setReducedMotion(false);
    const { swap } = mount(base, essResult);
    const total = () => screen.getByTestId("calculator-total").textContent ?? "";
    expect(total()).toMatch(/197/);
    swap({ ...base, attendances: 1000 }, profResult);
    expect(total()).not.toMatch(/497/);
    settle();
    expect(total()).toMatch(/497/);
  });

  it("com reduced motion vai direto ao valor final, sem requestAnimationFrame", () => {
    setReducedMotion(true);
    const raf = vi.spyOn(globalThis, "requestAnimationFrame");
    const { swap } = mount(base, essResult);
    swap({ ...base, attendances: 1000 }, profResult);
    expect(screen.getByTestId("calculator-total").textContent).toMatch(/497/);
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });

  it("anúncio só assenta depois do resultado final, não a cada quadro", () => {
    setReducedMotion(false);
    const { swap } = mount(base, essResult);
    swap({ ...base, attendances: 1000 }, profResult);
    expect(announced()).toMatch(/Essencial/);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(announced()).toMatch(/Essencial/);
    settle();
    expect(announced()).toMatch(/Profissional, R\$\s*497/);
  });
});
