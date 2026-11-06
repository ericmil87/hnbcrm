import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComposerView, type ComposerViewProps } from "./ComposerView";
import { isSendKey } from "@/lib/composerRules";
import { ScheduledPendingRow } from "./ScheduledPendingRow";
import { TranslationPreviewRow } from "./TranslationPreviewRow";
import { useComposerTranslation } from "./useComposerTranslation";
import {
  PreviewCache,
  type ComposerTranslationMode,
  type PreviewResponse,
  type PreviewResult,
  type SendPlan,
} from "@/lib/composerTranslation";

/** Envolve a view com estado de texto/nota, como o container faz. */
/** "Nota interna" agora é um item do menu "Mais opções". */
async function toggleInternalNote() {
  await userEvent.click(screen.getByRole("button", { name: "Mais opções" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /nota interna|voltar para mensagem/i }));
}

function Harness(props: Partial<ComposerViewProps> & { initialText?: string; initialInternal?: boolean }) {
  const { initialText = "", initialInternal = false, ...rest } = props;
  const [text, setText] = useState(initialText);
  const [isInternal, setInternal] = useState(initialInternal);
  return (
    <ComposerView
      text={text}
      onTextChange={setText}
      isInternal={isInternal}
      onInternalChange={setInternal}
      placeholder={isInternal ? "Escreva uma nota interna..." : "Digite uma mensagem..."}
      canSend={text.trim().length > 0}
      onSend={() => {}}
      teamMembers={[]}
      {...rest}
    />
  );
}

describe("ComposerView", () => {
  it("Enter envia e Shift+Enter não", () => {
    const onSend = vi.fn();
    render(<Harness initialText="olá" onSend={onSend} />);
    const field = screen.getByPlaceholderText("Digite uma mensagem...");
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("Enter sem conteúdo não envia", () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    fireEvent.keyDown(screen.getByPlaceholderText("Digite uma mensagem..."), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
  });

  it("os dropdowns de '/' e '@' consomem a tecla antes do envio", () => {
    const onSend = vi.fn();
    render(<Harness initialText="/oi" onSend={onSend} onKeyDownBefore={() => true} />);
    fireEvent.keyDown(screen.getByPlaceholderText("Digite uma mensagem..."), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("o botão de enviar dispara o envio", async () => {
    const onSend = vi.fn();
    render(<Harness initialText="olá" onSend={onSend} />);
    await userEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("nota interna muda o rótulo, o aviso e o estilo do campo", async () => {
    render(<Harness initialText="segredo" />);
    expect(screen.getByTestId("composer-pill").className).toContain("border-border-strong");
    expect(screen.queryByText(/visível só para a equipe/)).toBeNull();

    await toggleInternalNote();

    expect(screen.getByPlaceholderText("Escreva uma nota interna...")).toBeInTheDocument();
    expect(screen.getByTestId("composer-pill").className).toContain("border-bubble-note-border");
    expect(screen.getByText("Nota interna · visível só para a equipe")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adicionar nota" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enviar" })).toBeNull();

    // O X da faixa desliga a nota.
    await userEvent.click(screen.getByRole("button", { name: "Desativar nota interna" }));
    expect(screen.queryByText(/visível só para a equipe/)).toBeNull();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeInTheDocument();
  });

  it("sem a feature de nota interna o item some", () => {
    render(<Harness showInternalToggle={false} />);
    expect(screen.queryByRole("button", { name: "Mais opções" })).toBeNull();
  });

  it("o campo cresce com o texto e usa 16 px no celular", () => {
    render(<Harness initialText={"a\nb\nc\nd"} />);
    const field = screen.getByPlaceholderText("Digite uma mensagem...") as HTMLTextAreaElement;
    expect(field.className).toContain("text-base");
    expect(field.style.height).not.toBe("");
    expect(field.style.fontSize).toBe("");
  });

  it("no toque (ponteiro coarse) Enter quebra a linha e só o botão envia", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes("pointer: coarse"),
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      const onSend = vi.fn();
      render(<Harness initialText="olá" onSend={onSend} />);
      fireEvent.keyDown(screen.getByPlaceholderText("Digite uma mensagem..."), { key: "Enter" });
      expect(onSend).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Enviar" }));
      expect(onSend).toHaveBeenCalledTimes(1);
    } finally {
      window.matchMedia = original;
    }
  });

  it("o menu Mais opções oferece agendar e respostas rápidas", async () => {
    const onToggle = vi.fn();
    const onQuick = vi.fn();
    render(
      <Harness
        initialText="oi"
        onOpenQuickReplies={onQuick}
        schedule={{ open: false, value: "", onToggle, onChange: () => {}, onSubmit: () => {}, onClose: () => {} }}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Mais opções" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Agendar mensagem" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Mais opções" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Respostas rápidas" }));
    expect(onQuick).toHaveBeenCalledTimes(1);
  });

  it("mostra a janela de serviço e o tom de alerta quando fechada", () => {
    const { rerender } = render(<Harness windowInfo={{ text: "Janela fecha em 3h", closed: false }} />);
    expect(screen.getByText("Janela fecha em 3h").className).toContain("text-text-secondary");
    rerender(<Harness windowInfo={{ text: "Janela fechada — requer template", closed: true }} />);
    expect(screen.getByText("Janela fechada — requer template").className).toContain("text-semantic-warning");
  });

  it("contador de texto avisa quando a mensagem será dividida", () => {
    const { rerender } = render(<Harness textCounter={{ label: "120/1000", parts: 1, over: false }} />);
    expect(screen.getByText("120/1000").className).toContain("text-text-muted");
    rerender(<Harness textCounter={{ label: "1200/1000", parts: 2, over: true }} />);
    const counter = screen.getByText(/1200\/1000/);
    expect(counter).toHaveTextContent("a mensagem será enviada em cerca de 2 partes");
    expect(counter.className).toContain("text-semantic-warning");
  });

  it("janela fechada trava campo e envio", () => {
    render(<Harness initialText="oi" blocked />);
    expect(screen.getByPlaceholderText("Digite uma mensagem...")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
  });

  it("citação mostra autor, prévia e cancela", async () => {
    const onCancel = vi.fn();
    render(<Harness replyBar={{ author: "Ana", preview: "Bom dia", onCancel }} />);
    expect(screen.getByText("Respondendo Ana")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar resposta" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("agendar abre o popover sem enviar e confirma pelo botão", async () => {
    const onSend = vi.fn();
    const onSubmit = vi.fn();
    render(
      <Harness
        initialText="mais tarde"
        onSend={onSend}
        schedule={{ open: true, value: "2026-11-05T11:00", onToggle: () => {}, onChange: () => {}, onSubmit, onClose: () => {} }}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Agendar" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("o gravador de voz substitui o botão de enviar", () => {
    render(<Harness voice={<button type="button">Gravar</button>} />);
    expect(screen.getByRole("button", { name: "Gravar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enviar" })).toBeNull();
  });

  it("chip de idioma aparece na faixa e some na nota interna (nunca traduzida)", async () => {
    render(<Harness languageControl={<button type="button">ES · auto</button>} />);
    expect(screen.getByRole("button", { name: "ES · auto" })).toBeInTheDocument();
    await toggleInternalNote();
    expect(screen.queryByRole("button", { name: "ES · auto" })).not.toBeInTheDocument();
  });

  it("chip de idioma aparece mesmo sem o alternador de nota interna", () => {
    render(<Harness showInternalToggle={false} languageControl={<button type="button">ES · auto</button>} />);
    expect(screen.getByRole("button", { name: "ES · auto" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mais opções" })).not.toBeInTheDocument();
  });
});

// ── F3: prévia da tradução no composer ──────────────────────────────────────

/**
 * Mesma cola do `Composer.tsx` (hook + view + linha da prévia), com a action
 * `translation.preview` mockada e o envio registrado.
 */
function TranslatingHarness({
  mode,
  requestPreview,
  onSent,
}: {
  mode: ComposerTranslationMode;
  requestPreview: (args: { conversationId: string; text: string }) => Promise<PreviewResponse>;
  onSent: (plan: SendPlan, typed: string) => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [cache] = useState(() => new PreviewCache<PreviewResult>());
  const tr = useComposerTranslation({ conversationId: "c1", mode, targetLang: "es", text, requestPreview, cache });
  const send = async (opts: { untranslated?: boolean } = {}) => {
    const trimmed = text.trim();
    setSending(true);
    try {
      const plan = await tr.decide(text, opts);
      if (plan.kind === "confirm") return;
      onSent(plan, trimmed);
      // Igual ao Composer: só limpa o que foi enviado.
      setText((current) => (current.trim() === trimmed ? "" : current));
    } finally {
      setSending(false);
    }
  };
  return (
    <ComposerView
      text={text}
      onTextChange={setText}
      isInternal={false}
      onInternalChange={() => {}}
      placeholder="Digite uma mensagem..."
      canSend={text.trim().length > 0}
      sending={sending}
      onSend={() => void send()}
      sendingLabel={tr.waitingSend ? "Traduzindo…" : null}
      fieldReadOnly={tr.waitingSend}
      teamMembers={[]}
      translationPreview={
        tr.view ? (
          <TranslationPreviewRow
            view={tr.view}
            editing={tr.editing}
            editedText={tr.editedText}
            edited={tr.edited}
            armed={tr.armed}
            strict={mode === "strict"}
            onRetry={tr.retry}
            onEdit={tr.startEdit}
            onEditChange={tr.setEditedText}
            onRestore={tr.restoreTranslation}
            onUntranslated={() => void send({ untranslated: true })}
            onEditKeyDown={(e) => {
              if (!isSendKey(e)) return;
              e.preventDefault();
              void send();
            }}
          />
        ) : null
      }
    />
  );
}

const ES_PREVIEW = (text: string): PreviewResponse => ({
  text: text === "Olá, tudo bem?" ? "Hola, ¿qué tal?" : `ES(${text})`,
  sourceLang: "pt-BR",
  targetLang: "es",
  engine: "libretranslate",
  skipped: false,
});

describe("ComposerView + prévia da tradução (F3)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const field = () => screen.getByPlaceholderText("Digite uma mensagem...");
  const type = (value: string) => fireEvent.change(field(), { target: { value } });
  const settle = async (ms = 0) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
    await act(async () => {});
  };

  it("a prévia aparece depois do debounce e Enter envia a tradução mostrada", async () => {
    const requestPreview = vi.fn(async (a: { text: string }) => ES_PREVIEW(a.text));
    const onSent = vi.fn();
    render(<TranslatingHarness mode="quick" requestPreview={requestPreview} onSent={onSent} />);
    type("Olá, tudo bem?");
    await settle(300);
    expect(requestPreview).not.toHaveBeenCalled();
    expect(screen.getByText("Traduzindo…")).toBeInTheDocument();
    await settle(400);
    expect(requestPreview).toHaveBeenCalledTimes(1);
    expect(requestPreview).toHaveBeenCalledWith({ conversationId: "c1", text: "Olá, tudo bem?" });
    expect(screen.getByText("Espanhol:")).toBeInTheDocument();
    expect(screen.getByText("Hola, ¿qué tal?")).toBeInTheDocument();

    fireEvent.keyDown(field(), { key: "Enter" });
    await settle();
    expect(onSent).toHaveBeenCalledWith(
      {
        kind: "translated",
        content: "Hola, ¿qué tal?",
        translation: { authoredText: "Olá, tudo bem?", sourceLang: "pt-BR", targetLang: "es" },
      },
      "Olá, tudo bem?"
    );
  });

  it("Ctrl/Cmd+Enter é um Enter comum: envia a tradução (sem atalho de 'sem traduzir')", async () => {
    const requestPreview = vi.fn(async (a: { text: string }) => ES_PREVIEW(a.text));
    const onSent = vi.fn();
    render(<TranslatingHarness mode="quick" requestPreview={requestPreview} onSent={onSent} />);
    type("Olá, tudo bem?");
    await settle(700);
    fireEvent.keyDown(field(), { key: "Enter", ctrlKey: true });
    await settle();
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onSent.mock.calls[0][0]).toMatchObject({ kind: "translated", content: "Hola, ¿qué tal?" });
    type("Olá, tudo bem?");
    await settle();
    fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
    await settle();
    expect(onSent.mock.calls[1][0]).toMatchObject({ kind: "translated" });
  });

  it("Enter durante composição IME não envia, nem com Ctrl", async () => {
    const requestPreview = vi.fn(async (a: { text: string }) => ES_PREVIEW(a.text));
    const onSent = vi.fn();
    render(<TranslatingHarness mode="quick" requestPreview={requestPreview} onSent={onSent} />);
    type("Olá, tudo bem?");
    await settle(700);
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(field(), { key: "Enter", ctrlKey: true, isComposing: true });
    await settle();
    expect(onSent).not.toHaveBeenCalled();
  });

  it("o botão Sem traduzir da prévia envia como escrito, uma vez", async () => {
    const requestPreview = vi.fn(async (a: { text: string }) => ES_PREVIEW(a.text));
    const onSent = vi.fn();
    render(<TranslatingHarness mode="quick" requestPreview={requestPreview} onSent={onSent} />);
    type("Olá, tudo bem?");
    await settle(700);
    fireEvent.click(screen.getByRole("button", { name: "Sem traduzir" }));
    await settle();
    expect(onSent).toHaveBeenCalledWith({ kind: "untranslated" }, "Olá, tudo bem?");
    type("Olá, tudo bem?");
    await settle();
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle();
    expect(onSent.mock.calls[1][0]).toMatchObject({ kind: "translated" });
  });

  it("revisar antes: o primeiro Enter só mostra a prévia; o segundo envia", async () => {
    const requestPreview = vi.fn(async (a: { text: string }) => ES_PREVIEW(a.text));
    const onSent = vi.fn();
    render(<TranslatingHarness mode="strict" requestPreview={requestPreview} onSent={onSent} />);
    type("Olá, tudo bem?");
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle();
    expect(onSent).not.toHaveBeenCalled();
    expect(requestPreview).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Revise e confirme: Enter de novo envia.")).toBeInTheDocument();
    expect(screen.getByText("Hola, ¿qué tal?")).toBeInTheDocument();
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle();
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onSent.mock.calls[0][0]).toMatchObject({ kind: "translated", content: "Hola, ¿qué tal?" });
  });

  it("Enter com a prévia em voo: botão mostra Traduzindo… e envia quando ela chega", async () => {
    let resolve: (r: PreviewResponse) => void = () => {};
    const requestPreview = vi.fn(() => new Promise<PreviewResponse>((r) => (resolve = r)));
    const onSent = vi.fn();
    render(<TranslatingHarness mode="quick" requestPreview={requestPreview} onSent={onSent} />);
    type("Olá, tudo bem?");
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle();
    expect(requestPreview).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Traduzindo…" })).toBeDisabled();
    expect(onSent).not.toHaveBeenCalled();
    await act(async () => resolve(ES_PREVIEW("Olá, tudo bem?")));
    await settle();
    expect(onSent.mock.calls[0][0]).toMatchObject({ kind: "translated", content: "Hola, ¿qué tal?" });
  });

  it("texto digitado durante a espera não se perde: campo só leitura e envio só limpa o que saiu", async () => {
    let resolve: (r: PreviewResponse) => void = () => {};
    const requestPreview = vi.fn(() => new Promise<PreviewResponse>((r) => (resolve = r)));
    const onSent = vi.fn();
    render(<TranslatingHarness mode="quick" requestPreview={requestPreview} onSent={onSent} />);
    type("Olá, tudo bem?");
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle();
    expect(field()).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Traduzindo…" })).toBeDisabled();
    // Mesmo que algo entre no campo (colar programático), o envio não apaga.
    type("Olá, tudo bem? Mais uma coisa");
    await act(async () => resolve(ES_PREVIEW("Olá, tudo bem?")));
    await settle();
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onSent.mock.calls[0][1]).toBe("Olá, tudo bem?");
    expect(field()).toHaveValue("Olá, tudo bem? Mais uma coisa");
    expect(field()).not.toHaveAttribute("readonly");
  });

  it("prévia que não chega em 4 s: envia o digitado e o servidor traduz", async () => {
    const requestPreview = vi.fn(() => new Promise<PreviewResponse>(() => {}));
    const onSent = vi.fn();
    render(<TranslatingHarness mode="quick" requestPreview={requestPreview} onSent={onSent} />);
    type("Olá, tudo bem?");
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle(3_900);
    expect(onSent).not.toHaveBeenCalled();
    await settle(200);
    expect(onSent).toHaveBeenCalledWith({ kind: "plain" }, "Olá, tudo bem?");
  });

  it("Editar: a tradução vira campo editável e o envio leva edited", async () => {
    const requestPreview = vi.fn(async (a: { text: string }) => ES_PREVIEW(a.text));
    const onSent = vi.fn();
    render(<TranslatingHarness mode="quick" requestPreview={requestPreview} onSent={onSent} />);
    type("Olá, tudo bem?");
    await settle(700);
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    const edit = screen.getByLabelText("Tradução em espanhol");
    fireEvent.change(edit, { target: { value: "Hola, ¿cómo estás?" } });
    expect(screen.getByText("Tradução editada por você")).toBeInTheDocument();
    fireEvent.keyDown(edit, { key: "Enter" });
    await settle();
    expect(onSent.mock.calls[0][0]).toEqual({
      kind: "translated",
      content: "Hola, ¿cómo estás?",
      translation: { authoredText: "Olá, tudo bem?", sourceLang: "pt-BR", targetLang: "es", edited: true },
    });
  });

  it("redigitar o mesmo texto usa o cache (uma chamada só)", async () => {
    const requestPreview = vi.fn(async (a: { text: string }) => ES_PREVIEW(a.text));
    render(<TranslatingHarness mode="quick" requestPreview={requestPreview} onSent={vi.fn()} />);
    type("Olá, tudo bem?");
    await settle(700);
    type("Olá, tudo bem? E");
    await settle(100);
    type("Olá, tudo bem?");
    await settle(700);
    expect(requestPreview).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Hola, ¿qué tal?")).toBeInTheDocument();
  });

  it("já no idioma do lead (same_language): avisa e envia sem traduzir", async () => {
    const requestPreview = vi.fn(async (a: { text: string }) => ({
      text: a.text, sourceLang: "pt-BR", targetLang: "es", engine: null, skipped: true, reason: "same_language",
    }));
    const onSent = vi.fn();
    render(<TranslatingHarness mode="quick" requestPreview={requestPreview} onSent={onSent} />);
    type("Hola, ¿qué tal?");
    await settle(700);
    expect(screen.getByText("Já está em espanhol. Enviando sem traduzir.")).toBeInTheDocument();
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle();
    expect(onSent).toHaveBeenCalledWith({ kind: "untranslated" }, "Hola, ¿qué tal?");
  });

  it("texto longo (long_text): linha neutra e envio sem args, o servidor traduz", async () => {
    const requestPreview = vi.fn(async (a: { text: string }) => ({
      text: a.text, sourceLang: "pt-BR", targetLang: "es", engine: null, skipped: true, reason: "long_text",
    }));
    const onSent = vi.fn();
    render(<TranslatingHarness mode="quick" requestPreview={requestPreview} onSent={onSent} />);
    type("Olá, tudo bem?");
    await settle(700);
    expect(screen.getByText("Será traduzido ao enviar.")).toBeInTheDocument();
    expect(screen.queryByText(/Enviando sem traduzir/)).toBeNull();
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle();
    expect(onSent).toHaveBeenCalledWith({ kind: "plain" }, "Olá, tudo bem?");
  });

  it.each(["short", "low_confidence", "ask_mode", "language_off", "codigo_novo"])(
    "pulada por %s: nenhuma linha e envio sem args (nunca language:off)",
    async (reason) => {
      const requestPreview = vi.fn(async (a: { text: string }) => ({
        text: a.text, sourceLang: "pt-BR", targetLang: "es", engine: null, skipped: true, reason,
      }));
      const onSent = vi.fn();
      render(<TranslatingHarness mode="quick" requestPreview={requestPreview} onSent={onSent} />);
      type("Olá, tudo bem?");
      await settle(700);
      expect(screen.queryByTestId("translation-preview")).toBeNull();
      fireEvent.keyDown(field(), { key: "Enter" });
      await settle();
      expect(onSent).toHaveBeenCalledWith({ kind: "plain" }, "Olá, tudo bem?");
    }
  );

  it("revisar antes com a prévia em voo: Enter só arma, sem prazo, nada sai até a prévia aparecer", async () => {
    let resolve: (r: PreviewResponse) => void = () => {};
    const requestPreview = vi.fn(() => new Promise<PreviewResponse>((r) => (resolve = r)));
    const onSent = vi.fn();
    render(<TranslatingHarness mode="strict" requestPreview={requestPreview} onSent={onSent} />);
    type("Olá, tudo bem?");
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle();
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle(10_000);
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle(10_000);
    expect(onSent).not.toHaveBeenCalled();
    expect(screen.getByText("Aguarde a tradução para revisar e enviar.")).toBeInTheDocument();
    await act(async () => resolve(ES_PREVIEW("Olá, tudo bem?")));
    await settle();
    expect(onSent).not.toHaveBeenCalled();
    expect(screen.getByText("Hola, ¿qué tal?")).toBeInTheDocument();
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle();
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onSent.mock.calls[0][0]).toMatchObject({ kind: "translated", content: "Hola, ¿qué tal?" });
  });

  it("revisar antes com erro do provedor: não envia sozinho; Tentar de novo e Enviar sem traduzir", async () => {
    let fail = true;
    const requestPreview = vi.fn(async (a: { text: string }) => {
      if (fail) throw new Error("Nenhum provedor de tradução disponível");
      return ES_PREVIEW(a.text);
    });
    const onSent = vi.fn();
    render(<TranslatingHarness mode="strict" requestPreview={requestPreview} onSent={onSent} />);
    type("Olá, tudo bem?");
    await settle(700);
    expect(screen.getByText(/Nada é enviado sem você ver a tradução/)).toBeInTheDocument();
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle();
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle(10_000);
    expect(onSent).not.toHaveBeenCalled();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await settle();
    expect(requestPreview).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Hola, ¿qué tal?")).toBeInTheDocument();
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle();
    expect(onSent.mock.calls[0][0]).toMatchObject({ kind: "translated" });
  });

  it("revisar antes com erro: Enviar sem traduzir é explícito", async () => {
    const requestPreview = vi.fn(async () => {
      throw new Error("Nenhum provedor de tradução disponível");
    });
    const onSent = vi.fn();
    render(<TranslatingHarness mode="strict" requestPreview={requestPreview} onSent={onSent} />);
    type("Olá, tudo bem?");
    await settle(700);
    fireEvent.click(screen.getByRole("button", { name: "Enviar sem traduzir" }));
    await settle();
    expect(onSent).toHaveBeenCalledWith({ kind: "untranslated" }, "Olá, tudo bem?");
  });

  it("erro do provedor: mostra o motivo e o Enter cai no desvio do servidor", async () => {
    const requestPreview = vi.fn(async () => {
      throw new Error("Nenhum provedor de tradução disponível");
    });
    const onSent = vi.fn();
    render(<TranslatingHarness mode="quick" requestPreview={requestPreview} onSent={onSent} />);
    type("Olá, tudo bem?");
    await settle(700);
    expect(screen.getByText(/Prévia indisponível/)).toBeInTheDocument();
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle();
    expect(onSent).toHaveBeenCalledWith({ kind: "plain" }, "Olá, tudo bem?");
    expect(requestPreview).toHaveBeenCalledTimes(1);
  });

  it("enviar direto: nenhuma prévia, nenhum pedido", async () => {
    const requestPreview = vi.fn(async (a: { text: string }) => ES_PREVIEW(a.text));
    const onSent = vi.fn();
    render(<TranslatingHarness mode="off" requestPreview={requestPreview} onSent={onSent} />);
    type("Olá, tudo bem?");
    await settle(1_000);
    expect(screen.queryByTestId("translation-preview")).toBeNull();
    fireEvent.keyDown(field(), { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle();
    expect(requestPreview).not.toHaveBeenCalled();
    expect(onSent).toHaveBeenCalledWith({ kind: "plain" }, "Olá, tudo bem?");
  });
});

describe("ScheduledPendingRow traduzida (F3)", () => {
  it("mostra o que sai e alterna para o que a equipe escreveu", async () => {
    render(
      <ScheduledPendingRow
        item={{
          _id: "s1",
          content: "Hola, ¿mañana a las 10?",
          authoredText: "Olá, amanhã às 10?",
          targetLang: "es",
          scheduledAt: Date.now() + 60_000,
          createdAt: Date.now(),
        }}
        onCancel={() => {}}
        languageNote="traduzida para espanhol"
      />
    );
    expect(screen.getByText("Hola, ¿mañana a las 10?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Você escreveu" }));
    expect(screen.getByText("Olá, amanhã às 10?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ver o que será enviado" })).toHaveAttribute("aria-pressed", "true");
  });
});
