import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationLanguageChip } from "./ConversationLanguageChip";
import { conversationLanguageState } from "@/lib/translationRules";

const settings = { moduleEnabled: true, teamLanguage: "pt-BR", inboundMode: "auto" as const };
const state = (t: Record<string, unknown>) => conversationLanguageState({ translation: t }, settings);

function renderChip(over: Partial<React.ComponentProps<typeof ConversationLanguageChip>> = {}) {
  const props = {
    state: state({ lang: "es", mode: "auto" }),
    teamLanguage: "pt-BR",
    onSelect: vi.fn(),
    showBoth: false,
    onShowBothChange: vi.fn(),
    hasContact: true,
    ...over,
  };
  render(<ConversationLanguageChip {...props} />);
  return props;
}

describe("ConversationLanguageChip", () => {
  it("rótulo curto visível e nome completo para leitor de tela", () => {
    renderChip();
    const chip = screen.getByRole("button", { name: /Enviar em: Espanhol \(auto\)/ });
    expect(chip).toHaveTextContent("ES · auto");
    expect(chip).not.toHaveAttribute("title");
  });

  it("escolher um idioma fixa a conversa (com 'Aplicar ao contato')", async () => {
    const props = renderChip();
    await userEvent.click(screen.getByRole("button", { name: /Trocar idioma/ }));
    await userEvent.click(screen.getByLabelText(/Aplicar ao contato/));
    await userEvent.click(screen.getByRole("radio", { name: "Inglês" }));
    expect(props.onSelect).toHaveBeenCalledWith({ mode: "manual", lang: "en", applyToContact: true });
  });

  it("automático e 'não traduzir'", async () => {
    const props = renderChip({ state: state({ lang: "es", mode: "manual" }) });
    await userEvent.click(screen.getByRole("button", { name: /Trocar idioma/ }));
    expect(screen.getByRole("radio", { name: "Espanhol" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: /Português \(Brasil\) \(não traduzir\)/ }));
    expect(props.onSelect).toHaveBeenCalledWith({ mode: "off" });
  });

  it("devolve o foco ao fechar e alterna a preferência de mostrar original", async () => {
    const onClosed = vi.fn();
    const props = renderChip({ onClosed });
    await userEvent.click(screen.getByRole("button", { name: /Trocar idioma/ }));
    await userEvent.click(screen.getByLabelText(/Mostrar original junto da tradução/));
    expect(props.onShowBothChange).toHaveBeenCalledWith(true);
    await userEvent.click(screen.getByRole("radio", { name: /Automático/ }));
    expect(onClosed).toHaveBeenCalled();
  });

  it("some sem sinal de idioma e vira pílula de leitura sem permissão", () => {
    const { container } = render(
      <ConversationLanguageChip
        state={state({})}
        teamLanguage="pt-BR"
        onSelect={vi.fn()}
        showBoth={false}
        onShowBothChange={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
    renderChip({ readOnly: true });
    expect(screen.getByRole("status")).toHaveTextContent("ES · auto");
  });
});
