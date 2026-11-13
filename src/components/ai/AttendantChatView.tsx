import { useEffect, useRef, type FormEvent } from "react";
import { ArrowLeft, Bot, RotateCcw, SendHorizontal, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Bubble, ChipRow, TypingDots } from "@/components/landing/kit";
import { cn } from "@/lib/utils";
import type { SimTurn } from "./attendantSimulatorTypes";

export interface AttendantChatViewProps {
  /** Nome do atendente (cabeçalho e rótulo das respostas). */
  attendantName: string;
  transcript: SimTurn[];
  busy: boolean;
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  /** Perguntas sugeridas do segmento (chips acima do campo; tocar envia). */
  suggestions?: string[];
  onSuggestion: (text: string) => void;
  /** "Recomeçar teste": limpa a conversa de teste. */
  onReset: () => void;
  /** Sair do teste (seta do cabeçalho e o botão do erro). */
  onExit: () => void;
  exitLabel?: string;
  /** Ação principal depois do teste ("Está bom, conectar o WhatsApp"). */
  primaryAction?: { label: string; onClick: () => void };
  /** Erro do simulador (limite, modo leitura, IA desligada): texto do servidor em PT-BR. */
  error?: string | null;
  className?: string;
}

export const TEST_SAFE_NOTICE = "Teste sem risco: nada aqui chega a um cliente de verdade.";

/**
 * Teste da IA com cara de WhatsApp (apresentação, sem Convex): cabeçalho com o
 * atendente e o selo de IA, papel de parede e bolhas com os tokens de chat, a
 * pessoa escreve como cliente (à direita) e a IA responde (à esquerda), sugestões
 * do segmento como chips acima do campo, "Recomeçar teste" e a saída sempre à vista.
 * Ocupa a altura do pai (tela cheia no celular, área da conversa no computador).
 */
export function AttendantChatView({
  attendantName,
  transcript,
  busy,
  input,
  onInputChange,
  onSend,
  suggestions = [],
  onSuggestion,
  onReset,
  onExit,
  exitLabel = "Voltar para a configuração",
  primaryAction,
  error,
  className,
}: AttendantChatViewProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript.length, busy, error]);
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSend();
  };
  const chips = suggestions.slice(0, 4).map((s, i) => ({ id: `${i}:${s}`, label: s }));

  return (
    <section
      aria-label={`Teste da sua IA: ${attendantName}`}
      className={cn("flex min-h-0 flex-1 flex-col overflow-hidden bg-chat-bg lg:rounded-card lg:border lg:border-border-subtle lg:shadow-elevated", className)}
    >
      <header className="flex shrink-0 items-center gap-2 bg-chat-header px-2 py-1.5">
        <Button type="button" variant="ghost" size="sm" iconOnly aria-label={exitLabel} onClick={onExit} className="min-h-11 min-w-11">
          <ArrowLeft className="size-5" aria-hidden="true" />
        </Button>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ai-600 text-bubble-out-fg" aria-hidden="true">
          <Bot className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-text-primary">{attendantName}</span>
            <Badge variant="brand">IA</Badge>
          </p>
          <p className="truncate text-caption text-text-secondary" aria-live="polite">
            {busy ? "digitando…" : "Teste da sua IA"}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" aria-label="Recomeçar teste" onClick={onReset} disabled={busy || transcript.length === 0} className="min-h-11 min-w-11 shrink-0">
          <RotateCcw className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline" aria-hidden="true">
            Recomeçar teste
          </span>
        </Button>
      </header>

      <p role="note" className="flex shrink-0 items-center gap-1.5 border-b border-border-subtle bg-surface-sunken px-3 py-1.5 text-caption text-text-secondary">
        <ShieldCheck className="size-4 shrink-0 text-semantic-success" aria-hidden="true" />
        {TEST_SAFE_NOTICE}
      </p>

      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        aria-label="Conversa de teste"
        className="chat-wallpaper flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overscroll-contain px-3 py-3"
      >
        {transcript.length === 0 && (
          <Bubble variant="system">Escreva como se você fosse um cliente. A IA responde do jeito que vai responder no WhatsApp.</Bubble>
        )}
        {transcript.map((m, i) =>
          m.role === "customer" ? (
            <Bubble key={`t:${i}`} variant="out" ticks="read">
              <p className="whitespace-pre-wrap break-words">{m.content}</p>
            </Bubble>
          ) : (
            <Bubble key={`t:${i}`} variant="ai" side="start" label={attendantName}>
              <p className="whitespace-pre-wrap break-words">{m.content}</p>
            </Bubble>
          )
        )}
        {busy && <TypingDots label={`${attendantName} está digitando…`} />}
        {error && (
          <div role="alert" className="mx-2 mt-1 flex flex-wrap items-center gap-2 rounded-card border border-semantic-error/30 bg-semantic-error/10 px-3 py-2 text-sm text-text-primary">
            <p className="min-w-0 flex-1 basis-48">{error}</p>
            <Button type="button" variant="secondary" size="sm" onClick={onExit}>
              {exitLabel}
            </Button>
          </div>
        )}
      </div>

      <div className="shrink-0 bg-composer pb-safe">
        {primaryAction && (
          <div className="px-2 pt-2">
            <Button type="button" size="lg" className="w-full" onClick={primaryAction.onClick}>
              {primaryAction.label}
            </Button>
          </div>
        )}
        {chips.length > 0 && (
          <ChipRow label="Perguntas de cliente para testar" chips={chips} onSelect={(c) => onSuggestion(c.label)} disabled={busy} className="px-2 pt-2" />
        )}
        <form onSubmit={submit} className="flex items-center gap-2 px-2 py-2">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            aria-label="Mensagem do cliente"
            placeholder="Escreva como cliente…"
            maxLength={2000}
            className="min-h-11 min-w-0 flex-1 rounded-full bg-composer-field px-4 text-base text-text-primary placeholder:text-text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 md:text-sm"
          />
          <button
            type="submit"
            aria-label="Enviar mensagem"
            disabled={busy || !input.trim()}
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-chat-send text-bubble-out-fg transition-opacity disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base"
          >
            <SendHorizontal className="size-5" aria-hidden="true" />
          </button>
        </form>
      </div>
    </section>
  );
}
