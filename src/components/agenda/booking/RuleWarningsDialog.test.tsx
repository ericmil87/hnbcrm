import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ViolationView } from "@/lib/bookingFlow";
import { RuleWarningsDialog } from "./RuleWarningsDialog";

const warn = (code: string, resourceId?: string): ViolationView => ({ code, severity: "warn", message: "", ...(resourceId ? { detail: { resourceId } } : {}) });
const names = new Map([["r1", "Sala 1"], ["r2", "Ana"]]);

/** Faz o papel do contêiner: cada "Marcar mesmo assim" devolve o próximo resultado do servidor. */
function Harness({ first, answers, onForce }: { first: ViolationView[]; answers: Array<ViolationView[] | null>; onForce: (t: string[]) => void }) {
  const [violations, setViolations] = useState<ViolationView[] | null>(first);
  const n = useRef(0);
  return (
    <RuleWarningsDialog
      open={violations !== null}
      violations={violations ?? []}
      alternatives={[]}
      resourceNames={names}
      tz="America/Sao_Paulo"
      onForce={(tokens) => {
        onForce(tokens);
        setViolations(answers[n.current++] ?? null);
      }}
      onPickAlternative={() => setViolations(null)}
      onClose={() => setViolations(null)}
    />
  );
}

describe("RuleWarningsDialog: aceite por recurso", () => {
  it("manda o par dos avisos mostrados (recurso) e o código puro (agendamento inteiro)", async () => {
    const onForce = vi.fn();
    render(<Harness first={[warn("RESOURCE_CLOSED", "r1"), warn("OUTSIDE_HOURS")]} answers={[]} onForce={onForce} />);
    expect(screen.getByRole("heading", { name: "Antes de marcar" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Marcar mesmo assim" }));
    expect(onForce).toHaveBeenCalledWith(["RESOURCE_CLOSED:r1", "OUTSIDE_HOURS"]);
  });

  it("aviso novo depois de aceitar: reabre em destaque e a nova confirmação leva o aceito mais o novo", async () => {
    const onForce = vi.fn();
    render(
      <Harness
        first={[warn("RESOURCE_CLOSED", "r1")]}
        answers={[[warn("RESOURCE_CLOSED", "r1"), warn("RESOURCE_CLOSED", "r2")], null]}
        onForce={onForce}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Marcar mesmo assim" }));
    expect(screen.getByRole("heading", { name: "A agenda mudou: confira o aviso novo" })).toBeInTheDocument();
    expect(screen.getAllByText("Novo")).toHaveLength(1);
    expect(screen.getByText(/Ana/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Marcar mesmo assim" }));
    expect(onForce).toHaveBeenLastCalledWith(["RESOURCE_CLOSED:r1", "RESOURCE_CLOSED:r2"]);
    expect(screen.queryByRole("heading", { name: "A agenda mudou: confira o aviso novo" })).not.toBeInTheDocument();
  });

  it("reabrir depois de fechar começa limpo (sem destaque de aceite antigo)", async () => {
    const onForce = vi.fn();
    const { rerender } = render(<RuleWarningsDialog open violations={[warn("RESOURCE_CLOSED", "r1")]} alternatives={[]} tz="America/Sao_Paulo" onForce={onForce} onPickAlternative={() => {}} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Marcar mesmo assim" }));
    rerender(<RuleWarningsDialog open={false} violations={[]} alternatives={[]} tz="America/Sao_Paulo" onForce={onForce} onPickAlternative={() => {}} onClose={() => {}} />);
    rerender(<RuleWarningsDialog open violations={[warn("RESOURCE_CLOSED", "r2")]} alternatives={[]} tz="America/Sao_Paulo" onForce={onForce} onPickAlternative={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: "Antes de marcar" })).toBeInTheDocument();
  });
});
