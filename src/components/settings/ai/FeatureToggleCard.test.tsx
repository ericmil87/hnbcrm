import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Eye } from "lucide-react";
import { FeatureToggleCard } from "./FeatureToggleCard";

describe("FeatureToggleCard", () => {
  it("alterna pelo Switch e mostra título, descrição, custo e detalhe", () => {
    const onChange = vi.fn();
    render(
      <FeatureToggleCard icon={Eye} title="Ler imagens" description="Descreve fotos" costLabel="US$ 0,0003" checked={false} onChange={onChange}>
        <p>Detalhe</p>
      </FeatureToggleCard>,
    );
    expect(screen.getByText("Descreve fotos")).toBeInTheDocument();
    expect(screen.getByText("US$ 0,0003")).toBeInTheDocument();
    expect(screen.getByText("Detalhe")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Ler imagens" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("indisponível trava o interruptor e explica o motivo", () => {
    render(
      <FeatureToggleCard title="Recurso" description="d" available={false} unavailableReason="Conecte um número" checked onChange={() => {}} />,
    );
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByText("Conecte um número")).toBeInTheDocument();
  });

  it("sem onChange não há interruptor; aviso aparece", () => {
    render(<FeatureToggleCard title="Telegram" description="d" warning="Custo extra" />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByText("Custo extra")).toBeInTheDocument();
  });
});
