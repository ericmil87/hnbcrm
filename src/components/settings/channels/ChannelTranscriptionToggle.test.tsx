import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TranscriptionToggleView } from "./ChannelTranscriptionToggle";

describe("TranscriptionToggleView", () => {
  it("com permissão: o switch reflete o estado e chama onToggle", () => {
    const onToggle = vi.fn();
    render(<TranscriptionToggleView checked={false} canManage onToggle={onToggle} />);
    const sw = screen.getByRole("switch", { name: "Transcrever áudios automaticamente" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("sem permissão: só o selo Ativado/Desativado", () => {
    render(<TranscriptionToggleView checked canManage={false} onToggle={() => {}} />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByText("Ativado")).toBeInTheDocument();
  });

  it("description null esconde o texto", () => {
    render(<TranscriptionToggleView checked canManage onToggle={() => {}} description={null} />);
    expect(screen.queryByText(/Transcreve os áudios/)).not.toBeInTheDocument();
  });
});
