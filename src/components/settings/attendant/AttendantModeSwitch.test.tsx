import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AttendantModeSwitch } from "./AttendantModeSwitch";

const locked = { reviewed: 3, acceptanceRate: 0.5, proactive: 0, autopilotUnlocked: false };

describe("AttendantModeSwitch", () => {
  it("desbloqueado: ativa Responder sozinha com onChange", () => {
    const onChange = vi.fn();
    render(<AttendantModeSwitch value="suggest" onChange={onChange} metrics={{ ...locked, autopilotUnlocked: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Ativar Responder sozinha" }));
    expect(onChange).toHaveBeenCalledWith("autopilot");
  });

  it("em Responder sozinha: volta para Sugerir respostas e mostra o aceite antecipado", () => {
    const onChange = vi.fn();
    render(<AttendantModeSwitch value="autopilot" onChange={onChange} metrics={locked} earlyAckAt={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Voltar para Sugerir respostas" }));
    expect(onChange).toHaveBeenCalledWith("suggest");
    expect(screen.getByText(/antes da hora/)).toBeInTheDocument();
  });

  it("bloqueado: o aceite de risco exige o checkbox e chama onEarlyAutopilot", async () => {
    const onEarly = vi.fn().mockResolvedValue(true);
    render(<AttendantModeSwitch value="suggest" onChange={() => {}} metrics={locked} onEarlyAutopilot={onEarly} />);
    fireEvent.click(screen.getByRole("button", { name: "Já conheço: ativar agora" }));
    const confirm = screen.getByRole("button", { name: "Ativar Responder sozinha" });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirm);
    await waitFor(() => expect(onEarly).toHaveBeenCalledTimes(1));
  });

  it("disabled trava os botões", () => {
    render(<AttendantModeSwitch value="autopilot" onChange={() => {}} metrics={locked} disabled />);
    expect(screen.getByRole("button", { name: "Voltar para Sugerir respostas" })).toBeDisabled();
  });
});
