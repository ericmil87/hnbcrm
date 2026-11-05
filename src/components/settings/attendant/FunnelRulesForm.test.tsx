import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { pipelineFromProfile } from "@/lib/attendantConfig";
import { FunnelRulesForm } from "./FunnelRulesForm";

const value = pipelineFromProfile({});
const options = {
  boards: [{ _id: "b1", name: "Vendas" }],
  stages: [{ _id: "s1", name: "Proposta" }],
  leadFields: [{ key: "cidade", name: "Cidade" }],
};

describe("FunnelRulesForm", () => {
  it("escolher o funil limpa as etapas", () => {
    const onChange = vi.fn();
    render(<FunnelRulesForm value={{ ...value, initialStageId: "s1" }} onChange={onChange} options={options} />);
    fireEvent.change(screen.getByLabelText("Funil para novos leads"), { target: { value: "b1" } });
    expect(onChange).toHaveBeenCalledWith({ ...value, boardId: "b1", initialStageId: "", qualifiedStageId: "" });
  });

  it("marcar um campo capturado e mudar a regra chamam onChange", () => {
    const onChange = vi.fn();
    render(<FunnelRulesForm value={value} onChange={onChange} options={options} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenLastCalledWith({ ...value, captureFields: ["cidade"] });
    fireEvent.change(screen.getByLabelText("Quando avançar o lead"), { target: { value: "ao pedir orçamento" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, advanceRules: "ao pedir orçamento" });
  });

  it("mostra o erro do limiar com aria-invalid", () => {
    render(
      <FunnelRulesForm value={value} onChange={() => {}} options={options} errors={{ qualifyThreshold: "Use de 1 a 4" }} />,
    );
    expect(screen.getByLabelText("Limiar BANT")).toHaveAttribute("aria-invalid", "true");
  });

  it('variant="wizard" esconde as descrições longas', () => {
    const { rerender } = render(<FunnelRulesForm value={value} onChange={() => {}} options={options} />);
    expect(screen.getByText(/apenas em Responder sozinha/)).toBeInTheDocument();
    rerender(<FunnelRulesForm value={value} onChange={() => {}} options={options} variant="wizard" />);
    expect(screen.queryByText(/apenas em Responder sozinha/)).not.toBeInTheDocument();
  });
});
