import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BridgeAiMutedNoticeView } from "./BridgeAiCard";

describe("BridgeAiMutedNoticeView", () => {
  it("explica que a IA está muda e oferece o botão que resolve", () => {
    const onResolve = vi.fn();
    render(<BridgeAiMutedNoticeView onResolve={onResolve} />);
    expect(screen.getByRole("alert")).toHaveTextContent("A IA não está respondendo no seu número por QR code");
    fireEvent.click(screen.getByRole("button", { name: "Liberar a IA neste número" }));
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it("sem permissão para mudar: só o aviso, sem botão", () => {
    render(<BridgeAiMutedNoticeView />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
