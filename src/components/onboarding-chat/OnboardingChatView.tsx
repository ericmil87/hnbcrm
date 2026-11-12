import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router";
import { ClipboardList, RotateCcw, X } from "lucide-react";
import { ChatWindow, ChipRow, Composer, TypingDots } from "@/components/landing/kit";
import { PublicThemeButton } from "@/components/landing/PublicThemeButton";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { Button, buttonClassName } from "@/components/ui/Button";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { TimelineItem } from "@/lib/onboardingChat";
import { cn } from "@/lib/utils";
import { MessageItem } from "./MessageItem";
import { StageProgress } from "./StageProgress";
import type { BlockContext } from "./blocks/types";

export interface OnboardingChatViewProps {
  /** Etapa para a barra (`account` antes da conta/org; senão a do servidor). */
  stage: string | null;
  /** Conteúdo fixo antes do histórico (saudação, cartão de conta, criação da org). */
  intro?: ReactNode;
  timeline: readonly TimelineItem[];
  /** Copiloto "digitando…" (turno antes do `done`). */
  typing: boolean;
  /** Progresso do servidor ("Lendo o site…"); vira o status do cabeçalho. */
  status?: string | null;
  /** Mostra os três pontos na conversa (sem texto da resposta ainda). */
  showTypingBubble?: boolean;
  /** Chips do rodapé (tocar envia o texto). */
  chips: readonly string[];
  onChip: (text: string) => void;
  composerValue: string;
  onComposerChange: (value: string) => void;
  onSubmit: (text: string) => void;
  /** Campo desligado (sem conta/org). Durante um turno o campo segue ativo e só o envio espera. */
  composerDisabled?: boolean;
  composerPlaceholder?: string;
  /** Mensagem de erro do último turno (PT-BR). */
  error?: string | null;
  onRetry?: () => void;
  onDismissError?: () => void;
  canLoadMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  blockCtx: Omit<BlockContext, "isLatest">;
  /** Painel à direita no desktop (prévia viva). Ausente = conversa ocupa tudo. */
  preview?: ReactNode;
  /** Destino de "Prefiro preencher um formulário" (wizard v2). */
  formHref: string;
  onPreferForm?: () => void;
}

/**
 * Tela da conversa do onboarding (apresentação, sem Convex): visual do inbox
 * (kit `ChatWindow`/`Bubble`/`Composer`/`ChipRow`), barra de etapas, blocos ricos
 * pelo registro e, no desktop, a prévia viva à direita. No celular tudo fica na
 * conversa. A área de mensagens é `role="log"` (`ChatWindow live`).
 */
export function OnboardingChatView({
  stage,
  intro,
  timeline,
  typing,
  status,
  showTypingBubble = typing,
  chips,
  onChip,
  composerValue,
  onComposerChange,
  onSubmit,
  composerDisabled = false,
  composerPlaceholder = "Escreva sua mensagem",
  error,
  onRetry,
  onDismissError,
  canLoadMore = false,
  loadingMore = false,
  onLoadMore,
  blockCtx,
  preview,
  formHref,
  onPreferForm,
}: OnboardingChatViewProps) {
  const coarse = useMediaQuery("(pointer: coarse)");
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const firstKeyRef = useRef<string | null>(null);
  const last = timeline[timeline.length - 1];
  const lastSignature = `${last?.key ?? ""}:${last?.text.length ?? 0}:${last?.blocks.length ?? 0}:${showTypingBubble}`;

  // Mantém o fim da conversa à vista quando chega mensagem/texto; carregar
  // mensagens antigas (o primeiro item muda, o último não) não rola.
  useLayoutEffect(() => {
    const firstKey = timeline[0]?.key ?? null;
    const prependedOnly = firstKeyRef.current !== null && firstKey !== firstKeyRef.current;
    firstKeyRef.current = firstKey;
    if (prependedOnly) return;
    const scroller = endRef.current?.parentElement;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [lastSignature, timeline]);

  const focusComposer = () => {
    // No toque, focar abriria o teclado sem a pessoa pedir.
    if (coarse) return;
    composerRef.current?.querySelector("textarea")?.focus();
  };

  // Ao terminar um turno, o foco volta ao campo (o chip tocado some).
  const wasTyping = useRef(typing);
  useEffect(() => {
    if (wasTyping.current && !typing) focusComposer();
    wasTyping.current = typing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typing]);

  const chipItems = chips.slice(0, 6).map((label, i) => ({ id: `${i}:${label}`, label }));
  const latestAssistantKey = [...timeline].reverse().find((t) => t.role === "assistant")?.key;

  const footer = (
    <div ref={composerRef}>
      {error && (
        <div role="alert" className="mx-2 mt-2 flex items-start gap-2 rounded-card border border-semantic-error/30 bg-semantic-error/10 px-3 py-2 text-sm text-text-primary">
          <p className="min-w-0 flex-1 pt-1.5">{error}</p>
          {onRetry && (
            <Button type="button" variant="ghost" size="sm" onClick={onRetry} className="shrink-0">
              <RotateCcw className="size-4" aria-hidden="true" />
              Tentar de novo
            </Button>
          )}
          {onDismissError && (
            <Button type="button" variant="ghost" size="sm" iconOnly aria-label="Fechar aviso" onClick={onDismissError} className="shrink-0">
              <X className="size-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
      {chipItems.length > 0 && !typing && !composerDisabled && (
        <ChipRow
          label="Respostas sugeridas"
          chips={chipItems}
          onSelect={(chip) => onChip(chip.label)}
          className="px-2 pt-2"
        />
      )}
      <Composer
        value={composerValue}
        onChange={onComposerChange}
        onSubmit={onSubmit}
        label="Mensagem para o Copiloto"
        placeholder={composerPlaceholder}
        disabled={composerDisabled}
        pulse={false}
        maxLength={4000}
        autoFocus={!coarse && !composerDisabled}
        // Anexos e áudio chegam no P3.2: slots prontos e desligados.
        attachDisabled
        micDisabled
        attachLabel="Anexar arquivo (em breve)"
        micLabel="Gravar áudio (em breve)"
        className="pb-safe"
      />
    </div>
  );

  return (
    <div className="flex h-screen flex-col bg-surface-base supports-[height:100dvh]:h-[100dvh]">
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-1.5 md:px-4">
        <Link
          to="/"
          aria-label="HNBCRM, página inicial"
          className="inline-flex min-h-11 items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <BrandLogo size="sm" decorative />
          <span className="ml-2 hidden font-display text-base font-bold text-text-primary sm:inline">HNBCRM</span>
        </Link>
        <div className="flex-1" />
        <Link
          to={formHref}
          onClick={onPreferForm}
          className={cn(buttonClassName("ghost", "sm"), "min-h-11 text-caption sm:text-sm")}
        >
          <ClipboardList className="size-4" aria-hidden="true" />
          Prefiro preencher um formulário
        </Link>
        <PublicThemeButton />
      </header>

      <main className="flex min-h-0 flex-1">
        <h1 className="sr-only">Configure o seu CRM conversando com o Copiloto</h1>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:p-4">
          <ChatWindow
            title="Copiloto HNBCRM"
            subtitle="online"
            typing={typing}
            typingLabel={status || "digitando…"}
            live
            label="Conversa com o Copiloto HNBCRM"
            subheader={<StageProgress stage={stage} />}
            className="min-h-0 flex-1 rounded-none border-0 shadow-none lg:rounded-card lg:border lg:shadow-elevated"
            bodyClassName="min-h-0 overscroll-contain"
            composer={footer}
          >
            {canLoadMore && (
              <div className="flex justify-center pb-1">
                <Button type="button" variant="secondary" size="sm" loading={loadingMore} onClick={onLoadMore}>
                  Carregar mensagens anteriores
                </Button>
              </div>
            )}
            {intro}
            {timeline.map((item) => (
              <MessageItem
                key={item.key}
                item={item}
                blockCtx={blockCtx}
                isLatest={item.key === latestAssistantKey && item.key === last?.key}
              />
            ))}
            {showTypingBubble && <TypingDots label={status || "digitando…"} />}
            <div ref={endRef} aria-hidden="true" />
          </ChatWindow>
        </div>
        {preview && (
          <div className="hidden w-[22rem] shrink-0 border-l border-border-subtle bg-surface-sunken lg:flex lg:flex-col xl:w-[26rem]">
            {preview}
          </div>
        )}
      </main>
    </div>
  );
}
