import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "@/test/render";
import { VoiceReplyCardView, type VoiceReplyCardViewProps, type VoiceReplySettings } from "./VoiceReplyCard";

const base: VoiceReplySettings = {
  enabled: false,
  voice: "nova",
  configuredVoice: null,
  defaultVoice: "nova",
  voices: ["alloy", "nova", "onyx"],
  notice: null,
  noticeMaxChars: 80,
  model: "tts-model",
  platformReady: true,
  aiActive: true,
};

function setup(settings: Partial<VoiceReplySettings> = {}, over: Partial<VoiceReplyCardViewProps> = {}) {
  const onSave = vi.fn();
  renderWithRouter(<VoiceReplyCardView settings={{ ...base, ...settings }} canManage onSave={onSave} {...over} />);
  return onSave;
}

describe("VoiceReplyCardView", () => {
  it("desligado: explica as regras e liga pelo interruptor", async () => {
    const onSave = setup();
    expect(screen.getByText(/Valores, links, Pix, endereços e telefones sempre vão por escrito/)).toBeInTheDocument();
    const sw = screen.getByRole("switch", { name: "Responder em áudio" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    expect(onSave).toHaveBeenCalledWith({ voiceReplyEnabled: true });
  });

  it("ligado: desligar envia false; voz padrão destacada e troca de voz grava", async () => {
    const onSave = setup({ enabled: true });
    expect(screen.getByRole("switch", { name: "Responder em áudio" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("option", { name: "nova (padrão)" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Voz"), "onyx");
    expect(onSave).toHaveBeenCalledWith({ voiceReplyVoice: "onyx" });
    await userEvent.click(screen.getByRole("switch", { name: "Responder em áudio" }));
    expect(onSave).toHaveBeenLastCalledWith({ voiceReplyEnabled: false });
  });

  it("aviso: contador, limite, salvar e remover (string vazia)", async () => {
    const onSave = setup({ notice: "Sou a assistente da Loja" });
    const input = screen.getByLabelText("Aviso de voz sintética (opcional)");
    expect(input).toHaveAttribute("maxLength", "80");
    expect(input).toHaveAttribute("placeholder", "Sou a assistente virtual da Loja Exemplo");
    expect(screen.getByText("24/80")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Salvar aviso" })).not.toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.click(screen.getByRole("button", { name: "Salvar aviso" }));
    expect(onSave).toHaveBeenCalledWith({ voiceReplyNotice: "" });
    await userEvent.type(input, "Olá");
    await userEvent.click(screen.getByRole("button", { name: "Salvar aviso" }));
    expect(onSave).toHaveBeenLastCalledWith({ voiceReplyNotice: "Olá" });
  });

  it("IA inativa: interruptor travado (clique não grava), campos travados, explicação e link", async () => {
    const onSave = setup({ aiActive: false });
    const sw = screen.getByRole("switch", { name: "Responder em áudio" });
    expect(sw).toBeDisabled();
    await userEvent.click(sw);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Voz")).toBeDisabled();
    expect(screen.getByText("As mudanças deste bloco são salvas na hora.")).toBeInTheDocument();
    expect(screen.getByText(/A IA não está ativa/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ativar a IA" })).toHaveAttribute("href", expect.stringContaining("secao=ai"));
  });

  it("plataforma indisponível: aviso e interruptor travado quando desligado", () => {
    setup({ platformReady: false });
    expect(screen.getByText(/indisponível no momento/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Responder em áudio" })).toBeDisabled();
  });

  it("plataforma indisponível com recurso ligado ainda permite desligar", () => {
    setup({ platformReady: false, enabled: true });
    expect(screen.getByRole("switch", { name: "Responder em áudio" })).toBeEnabled();
  });

  it("IA inativa com recurso ligado ainda permite desligar", async () => {
    const onSave = setup({ aiActive: false, enabled: true });
    await userEvent.click(screen.getByRole("switch", { name: "Responder em áudio" }));
    expect(onSave).toHaveBeenCalledWith({ voiceReplyEnabled: false });
  });

  it("aviso: só espaços diferentes não é alteração; salva normalizado e avisa o painel", async () => {
    const onDirtyChange = vi.fn();
    const onSave = vi.fn().mockResolvedValue(true);
    setup({ notice: "Sou a assistente" }, { onDirtyChange, onSave });
    const input = screen.getByLabelText("Aviso de voz sintética (opcional)");
    await userEvent.type(input, "  ");
    expect(screen.queryByRole("button", { name: "Salvar aviso" })).not.toBeInTheDocument();
    await userEvent.type(input, "  da   Loja");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await userEvent.click(screen.getByRole("button", { name: "Salvar aviso" }));
    expect(onSave).toHaveBeenCalledWith({ voiceReplyNotice: "Sou a assistente da Loja" });
  });

  it("somente leitura: tudo travado, sem botões de salvar", () => {
    setup({ enabled: true, notice: "Aviso" }, { canManage: false });
    expect(screen.getByRole("switch", { name: "Responder em áudio" })).toBeDisabled();
    expect(screen.getByLabelText("Voz")).toBeDisabled();
    expect(screen.getByLabelText("Aviso de voz sintética (opcional)")).toBeDisabled();
    expect(screen.getByText(/Só quem gerencia/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Salvar aviso" })).not.toBeInTheDocument();
  });

  it("salvando trava os controles", () => {
    setup({ enabled: true }, { saving: true });
    expect(screen.getByRole("switch", { name: "Responder em áudio" })).toBeDisabled();
  });

  it("erro do servidor aparece e some ao editar o aviso; no campo vira aria-invalid", async () => {
    const onSave = vi.fn().mockResolvedValue(false);
    renderWithRouter(
      <VoiceReplyCardView settings={{ ...base, enabled: true }} canManage onSave={onSave} error="O aviso não pode conter números." />,
    );
    const input = screen.getByLabelText("Aviso de voz sintética (opcional)");
    await userEvent.type(input, "Ligue 123");
    await userEvent.click(screen.getByRole("button", { name: "Salvar aviso" }));
    expect(onSave).toHaveBeenCalledWith({ voiceReplyNotice: "Ligue 123" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("O aviso não pode conter números.")).toBeInTheDocument();
    await userEvent.type(input, "x");
    expect(screen.queryByText("O aviso não pode conter números.")).not.toBeInTheDocument();
  });

  it("erro de outra ação aparece em alerta", async () => {
    renderWithRouter(
      <VoiceReplyCardView settings={{ ...base, enabled: true }} canManage onSave={vi.fn()} error="Não foi possível salvar a resposta em áudio." />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível salvar");
  });
});
