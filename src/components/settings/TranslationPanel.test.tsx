import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "@/test/render";
import { TranslationPanelView, parseGlossary, type TranslationPanelViewProps } from "./TranslationPanel";

const settings = {
  provider: "auto" as const,
  teamLanguage: "pt-BR",
  inboundMode: "auto" as const,
  outboundMode: "quick_review" as const,
  skipWhenSameLanguage: true,
  tone: "neutral" as const,
  glossary: ["Residencial Aurora"],
};

function setup(over: Partial<TranslationPanelViewProps> = {}) {
  const props: TranslationPanelViewProps = {
    moduleEnabled: true,
    settings,
    providers: { libretranslate: true, llm: false },
    canManage: true,
    onToggleModule: vi.fn(),
    onPatch: vi.fn(),
    onPing: vi.fn(),
    advancedHref: "/app/configuracoes?secao=ai-models",
    ...over,
  };
  renderWithRouter(<TranslationPanelView {...props} />);
  return props;
}

describe("TranslationPanelView", () => {
  it("ligar exige o aceite de privacidade", async () => {
    const props = setup({ moduleEnabled: false });
    await userEvent.click(await screen.findByRole("switch", { name: "Tradução automática" }));
    expect(props.onToggleModule).not.toHaveBeenCalled();
    const activate = screen.getByRole("button", { name: "Ativar tradução" });
    expect(activate).toBeDisabled();
    await userEvent.click(screen.getByLabelText("Li e aceito"));
    await userEvent.click(activate);
    expect(props.onToggleModule).toHaveBeenCalledWith(true);
  });

  it("módulo desligado esconde os ajustes; desligar não pede aceite", async () => {
    setup({ moduleEnabled: false });
    expect(await screen.findByRole("switch", { name: "Tradução automática" })).toBeInTheDocument();
    expect(screen.queryByText("Glossário")).not.toBeInTheDocument();
    const props = setup({ moduleEnabled: true });
    await userEvent.click(screen.getAllByRole("switch", { name: "Tradução automática" })[1]);
    expect(props.onToggleModule).toHaveBeenCalledWith(false);
  });

  it("ao responder: três modos, revisar rápido marcado, escolher grava outboundMode", async () => {
    const props = setup();
    const group = await screen.findByRole("radiogroup", { name: "Ao responder" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Revisar rápido (recomendado)" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Revisar antes de enviar (confirmar 2 vezes)" }));
    expect(props.onPatch).toHaveBeenCalledWith({ outboundMode: "strict_review" });
    await userEvent.click(screen.getByRole("radio", { name: "Enviar direto" }));
    expect(props.onPatch).toHaveBeenCalledWith({ outboundMode: "direct" });
  });

  it("ao responder: sem permissão não grava", async () => {
    const props = setup({ canManage: false });
    await userEvent.click(await screen.findByRole("radio", { name: "Enviar direto" }));
    expect(props.onPatch).not.toHaveBeenCalled();
  });

  it("modo ao receber, provedor e glossário gravam o patch", async () => {
    const props = setup();
    await userEvent.click(await screen.findByRole("radio", { name: "Perguntar antes" }));
    expect(props.onPatch).toHaveBeenCalledWith({ inboundMode: "ask" });
    await userEvent.selectOptions(screen.getByLabelText("Provedor de tradução"), "llm");
    expect(props.onPatch).toHaveBeenCalledWith({ provider: "llm" });
    const field = screen.getByLabelText("Um termo por linha");
    await userEvent.type(field, "{enter}Imobiliária Sol");
    await userEvent.click(screen.getByRole("button", { name: "Salvar glossário" }));
    expect(props.onPatch).toHaveBeenCalledWith({ glossary: ["Residencial Aurora", "Imobiliária Sol"] });
  });

  it("mostra a disponibilidade e o resultado do teste", async () => {
    const props = setup({ pingResults: [{ engine: "libretranslate", ok: true, latencyMs: 320 }] });
    expect(await screen.findByText("Servidor próprio: disponível")).toBeInTheDocument();
    expect(screen.getByText("IA da organização: desligada")).toBeInTheDocument();
    expect(screen.getByText("320 ms")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Testar conexão/ }));
    expect(props.onPing).toHaveBeenCalled();
  });

  it("sem permissão de gerenciar, tudo travado", async () => {
    setup({ canManage: false });
    expect(await screen.findByRole("switch", { name: "Tradução automática" })).toBeDisabled();
    expect(screen.getByLabelText("Idioma da equipe")).toBeDisabled();
  });

  it("parseGlossary tira vazios e repetidos", () => {
    expect(parseGlossary(" A \n\na\nB ")).toEqual(["A", "B"]);
  });
});
