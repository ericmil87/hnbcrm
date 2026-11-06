import { describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "@/test/render";
import { AUTO_BANNER_HIDE_MS, TranslationBanner } from "./TranslationBanner";

const base = { languageName: "espanhol", teamLabel: "pt-BR", canChoose: true, onDismiss: vi.fn() };

describe("TranslationBanner", () => {
  it("automático: desfazer, idioma, não traduzir o contato", async () => {
    const onUndo = vi.fn();
    const onPickLanguage = vi.fn();
    const onNeverForContact = vi.fn();
    renderWithRouter(
      <TranslationBanner {...base} kind="auto" onUndo={onUndo} onPickLanguage={onPickLanguage} onNeverForContact={onNeverForContact} />
    );
    expect(await screen.findByText("Conversa em espanhol: traduzindo para pt-BR.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Desfazer" }));
    await userEvent.click(screen.getByRole("button", { name: "Idioma" }));
    await userEvent.click(screen.getByRole("button", { name: "Não traduzir este contato" }));
    expect(onUndo).toHaveBeenCalled();
    expect(onPickLanguage).toHaveBeenCalled();
    expect(onNeverForContact).toHaveBeenCalled();
  });

  it("automático some sozinho depois de 8 s", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      renderWithRouter(<TranslationBanner {...base} kind="auto" onDismiss={onDismiss} />);
      act(() => {
        vi.advanceTimersByTime(AUTO_BANNER_HIDE_MS + 10);
      });
      expect(onDismiss).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("perguntar: sim, não, outro idioma (sem fechar)", async () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    renderWithRouter(<TranslationBanner {...base} kind="ask" onAccept={onAccept} onDecline={onDecline} onPickLanguage={vi.fn()} />);
    expect(await screen.findByText("Este lead parece falar espanhol. Traduzir esta conversa?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sim, traduzir" }));
    await userEvent.click(screen.getByRole("button", { name: "Não" }));
    expect(onAccept).toHaveBeenCalled();
    expect(onDecline).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Outro idioma" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fechar aviso" })).not.toBeInTheDocument();
  });

  it("descoberta leva às configurações", async () => {
    renderWithRouter(<TranslationBanner {...base} kind="discover" settingsHref="/app/configuracoes?secao=translation" />);
    const link = await screen.findByRole("link", { name: "Ver tradução automática" });
    expect(link).toHaveAttribute("href", "/app/configuracoes?secao=translation");
  });

  it("sem permissão de responder, só informa", async () => {
    renderWithRouter(<TranslationBanner {...base} kind="ask" canChoose={false} />);
    await screen.findByText(/Traduzir esta conversa/);
    expect(screen.queryByRole("button", { name: "Sim, traduzir" })).not.toBeInTheDocument();
  });
});
