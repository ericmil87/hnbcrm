import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageTranslation } from "./MessageTranslation";
import { translationView } from "@/lib/translationRules";

const ctx = { conversationActive: true, now: 10_000 };
const base = { direction: "inbound", senderType: "contact", isInternal: false, createdAt: 9_000 };

const inboundDone = translationView(
  {
    ...base,
    content: "Hola, ¿qué tal?",
    translatedText: "Olá, tudo bem?",
    metadata: { translation: { status: "done", role: "inbound", sourceLang: "es", targetLang: "pt-BR", at: 1 } },
  },
  ctx
);

describe("MessageTranslation", () => {
  it("recebida: tradução em destaque, original atrás do rótulo e de volta", async () => {
    if (inboundDone.kind === "none") throw new Error("esperava tradução");
    render(<MessageTranslation view={inboundDone} text="Hola, ¿qué tal?" variant="inbound" />);
    expect(screen.getByText("Olá, tudo bem?")).toBeInTheDocument();
    expect(screen.queryByText("Hola, ¿qué tal?")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /Espanhol → pt-BR.*Ver original/ });
    await userEvent.click(toggle);
    expect(screen.getByText("Hola, ¿qué tal?")).toBeInTheDocument();
    expect(screen.getByText("Hola, ¿qué tal?").closest("[lang]")).toHaveAttribute("lang", "es");
    await userEvent.click(screen.getByRole("button", { name: /Ver tradução/ }));
    expect(screen.getByText("Olá, tudo bem?")).toBeInTheDocument();
  });

  it("preferência 'mostrar original junto' mostra os dois", () => {
    if (inboundDone.kind === "none") throw new Error("esperava tradução");
    render(<MessageTranslation view={inboundDone} text="Hola, ¿qué tal?" variant="inbound" showBoth />);
    expect(screen.getByText("Olá, tudo bem?")).toBeInTheDocument();
    expect(screen.getByText("Hola, ¿qué tal?")).toBeInTheDocument();
  });

  it("traduzindo mostra o original na hora", () => {
    render(<MessageTranslation view={{ kind: "translating", inferred: true }} text="Hola" variant="inbound" />);
    expect(screen.getByText("Hola")).toBeInTheDocument();
    expect(screen.getByText("Traduzindo…")).toBeInTheDocument();
  });

  it("falha da recebida oferece tentar de novo", async () => {
    const onRetry = vi.fn();
    render(<MessageTranslation view={{ kind: "failed" }} text="Hola" variant="inbound" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: /Tentar de novo/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("enviada pendente avisa que está traduzindo e enviando", () => {
    render(<MessageTranslation view={{ kind: "outbound_pending" }} text="Temos sim" variant="outbound" />);
    expect(screen.getByText("Traduzindo e enviando…")).toBeInTheDocument();
  });

  it("enviada com falha: tentar de novo e enviar sem traduzir só depois de confirmar", async () => {
    const onRetryOutbound = vi.fn();
    const onSendUntranslated = vi.fn();
    render(
      <MessageTranslation
        view={{ kind: "outbound_failed" }}
        text="Temos sim"
        variant="outbound"
        onRetryOutbound={onRetryOutbound}
        onSendUntranslated={onSendUntranslated}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: /Tentar de novo/ }));
    expect(onRetryOutbound).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: /Enviar sem traduzir/ }));
    expect(onSendUntranslated).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole("button", { name: "Enviar sem traduzir" });
    await userEvent.click(buttons[buttons.length - 1]);
    expect(onSendUntranslated).toHaveBeenCalledTimes(1);
  });

  it("enviada sem tradução ganha o rótulo", () => {
    render(<MessageTranslation view={{ kind: "outbound_skipped" }} text="Oi" variant="outbound" />);
    expect(screen.getByText("Enviado sem tradução")).toBeInTheDocument();
  });

  it("enviada traduzida: o que o lead recebeu em destaque, pt-BR ao tocar", async () => {
    const view = translationView(
      {
        ...base,
        direction: "outbound",
        senderType: "user",
        content: "¡Sí tenemos!",
        translatedText: "Temos sim!",
        metadata: { translation: { status: "done", role: "outbound", sourceLang: "pt-BR", targetLang: "es", at: 1 } },
      },
      ctx
    );
    if (view.kind === "none") throw new Error("esperava tradução");
    render(<MessageTranslation view={view} text="¡Sí tenemos!" variant="outbound" />);
    expect(screen.getByText("¡Sí tenemos!")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Você escreveu/ }));
    expect(screen.getByText("Temos sim!")).toBeInTheDocument();
  });

  it("idioma incerto (F3): oferece traduzir como o idioma provável", async () => {
    const onTranslateAs = vi.fn();
    render(
      <MessageTranslation view={{ kind: "uncertain", lang: "es" }} text="Hola" variant="inbound" onTranslateAs={onTranslateAs} />
    );
    expect(screen.getByText("Hola")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Idioma incerto · Traduzir como espanhol?" }));
    expect(onTranslateAs).toHaveBeenCalledWith("es");
  });
});
