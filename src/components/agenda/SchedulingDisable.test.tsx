import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), readOnly: false }));
vi.mock("convex/react", () => ({ useMutation: () => mocks.mutate }));
vi.mock("@/hooks/useAccountReadOnly", () => ({ useAccountReadOnly: () => mocks.readOnly }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SchedulingDisableButton, SchedulingEnableCardView, disableDialogText } from "./SchedulingEnableCard";

describe("desligar o agendamento", () => {
  beforeEach(() => {
    mocks.mutate.mockReset().mockResolvedValue({});
    mocks.readOnly = false;
  });

  it("um clique só abre a confirmação; nada é desligado ainda", async () => {
    render(<SchedulingDisableButton organizationId={"org1" as never} />);
    await userEvent.click(screen.getByRole("button", { name: "Desligar agendamento" }));
    expect(screen.getByText("Desligar agendamento?")).toBeInTheDocument();
    expect(screen.getByText(/Os agendamentos ficam guardados, nada é apagado/)).toBeInTheDocument();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("confirmar desliga; cancelar não", async () => {
    render(<SchedulingDisableButton organizationId={"org1" as never} />);
    await userEvent.click(screen.getByRole("button", { name: "Desligar agendamento" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(mocks.mutate).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Desligar agendamento" }));
    await userEvent.click(screen.getByRole("button", { name: "Desligar" }));
    expect(mocks.mutate).toHaveBeenCalledWith({ organizationId: "org1", modules: { scheduling: false } });
  });

  it("modo leitura acrescenta o aviso de que não dá para religar", async () => {
    mocks.readOnly = true;
    expect(disableDialogText(true)).toMatch(/não vai conseguir ligar de novo até renovar o plano\.$/);
    expect(disableDialogText(false)).not.toMatch(/modo leitura/);
    render(<SchedulingDisableButton organizationId={"org1" as never} />);
    await userEvent.click(screen.getByRole("button", { name: "Desligar agendamento" }));
    expect(screen.getByText(/modo leitura, você não vai conseguir/)).toBeInTheDocument();
  });

  it("cartão Ativar avisa antes do clique quando a conta está em modo leitura", () => {
    const { rerender } = render(<SchedulingEnableCardView state="ready" readOnly onActivate={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent(/modo leitura/);
    rerender(<SchedulingEnableCardView state="ready" onActivate={() => {}} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
