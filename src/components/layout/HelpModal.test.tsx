import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HelpModal } from "./HelpModal";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("HelpModal", () => {
  it("sem VITE_COMMUNITY_URL só mostra o tutorial", () => {
    vi.stubEnv("VITE_COMMUNITY_URL", "");
    render(<HelpModal open onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Tutorial do atendente" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Comunidade HNBCRM/ })).toBeNull();
  });

  it("URL que não é https não aparece", () => {
    vi.stubEnv("VITE_COMMUNITY_URL", "http://chat.example.com/x");
    render(<HelpModal open onClose={vi.fn()} />);
    expect(screen.queryByRole("link", { name: /Comunidade HNBCRM/ })).toBeNull();
  });

  it("com a env mostra a comunidade em nova aba, com rel seguro", () => {
    vi.stubEnv("VITE_COMMUNITY_URL", "https://chat.example.com/grupo");
    render(<HelpModal open onClose={vi.fn()} />);
    const link = screen.getByRole("link", { name: /Comunidade HNBCRM/ });
    expect(link).toHaveAttribute("href", "https://chat.example.com/grupo");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("Tutorial do atendente fecha o menu e abre o tutorial", async () => {
    vi.stubEnv("VITE_COMMUNITY_URL", "");
    const onClose = vi.fn();
    render(<HelpModal open onClose={onClose} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Tutorial do atendente" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog", { name: "Tutorial do atendente" })).toBeInTheDocument();
  });
});
