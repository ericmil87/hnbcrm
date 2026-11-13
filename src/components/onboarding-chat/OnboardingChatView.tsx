import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ClipboardList, LayoutDashboard, ListChecks, MoreVertical, RotateCcw, X } from "lucide-react";
import { ChatWindow, ChipRow, Composer, TypingDots } from "@/components/landing/kit";
import { PublicThemeButton } from "@/components/landing/PublicThemeButton";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { Button, buttonClassName } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { Modal } from "@/components/ui/Modal";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { AI_PROCESSING_NOTICE, supersededBlockKeys, type ProgressView, type TimelineItem } from "@/lib/onboardingChat";
import { isNearBottom, newContentScroll } from "@/lib/onboardingScroll";
import { cn } from "@/lib/utils";
import { MessageItem } from "./MessageItem";
import { NextStepBar, type NextStepBarProps } from "./NextStepBar";
import { StageProgress } from "./StageProgress";
import type { BlockContext } from "./blocks/types";

export interface OnboardingChatViewProps {
  /** Progresso das 6 etapas (`accountProgress` antes da conta/org; senão `chatProgress`). */
  progress: ProgressView;
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
  /** O mesmo painel para a folha do celular (botão "Sua operação" no cabeçalho). Padrão: `preview`. */
  previewSheet?: ReactNode;
  /** Barra do próximo passo, sempre acima do campo de mensagem. Ausente = sem a barra (ex.: sem conta). */
  nextStep?: NextStepBarProps;
  /** Destino de "Prefiro preencher um formulário" (wizard v2). */
  formHref: string;
  onPreferForm?: () => void;
  /** Saída para o CRM (quem já tem organização não fica preso na conversa). Ausente = sem o link. */
  appHref?: string;
  /** Clipe e microfone (P3.2). Sem handler ficam desligados. */
  onAttach?: () => void;
  onMic?: () => void;
  /** Conteúdo depois da última mensagem (ex.: cartão de conta/aviso pedido por um anexo recusado). */
  tail?: ReactNode;
  /** "Recomeçar a conversa" no menu do cabeçalho (abre a confirmação). Ausente = sem o menu. */
  onRestart?: () => void;
  /**
   * Muda a cada ação da pessoa (enviar, tocar num cartão): o conteúdo que chegar em seguida é
   * mostrado mesmo que ela tenha rolado para cima. Sem ação, só segue quem estava no fim.
   */
  userActionTick?: number;
  /** Tela que toma o lugar da conversa (ex.: teste da IA). A conversa continua montada, escondida. */
  takeover?: ReactNode;
}

/**
 * Tela da conversa do onboarding (apresentação, sem Convex): visual do inbox
 * (kit `ChatWindow`/`Bubble`/`Composer`/`ChipRow`), barra de etapas, blocos ricos
 * pelo registro e, no desktop, a prévia viva à direita. No celular tudo fica na
 * conversa. A área de mensagens é `role="log"` (`ChatWindow live`).
 */
export function OnboardingChatView({
  progress,
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
  previewSheet,
  nextStep,
  formHref,
  onPreferForm,
  appHref,
  onAttach,
  onMic,
  tail,
  onRestart,
  userActionTick = 0,
  takeover,
}: OnboardingChatViewProps) {
  const coarse = useMediaQuery("(pointer: coarse)");
  const [sheetOpen, setSheetOpen] = useState(false);
  const superseded = useMemo(() => supersededBlockKeys(timeline), [timeline]);
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const firstKeyRef = useRef<string | null>(null);
  const last = timeline[timeline.length - 1];
  const lastSignature = `${last?.key ?? ""}:${last?.text.length ?? 0}:${last?.blocks.length ?? 0}:${showTypingBubble}`;

  // Quem rolou para cima para ler não é puxado para baixo (só quem está no fim ou acabou de agir).
  const followRef = useRef(true);
  const actedTickRef = useRef(userActionTick);
  useEffect(() => {
    const scroller = endRef.current?.parentElement;
    if (!scroller) return;
    const onScroll = () => {
      followRef.current = isNearBottom({ scrollTop: scroller.scrollTop, height: scroller.clientHeight, scrollHeight: scroller.scrollHeight });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, []);

  // Conteúdo novo no fim: cola no fim, ou mostra o TOPO de um cartão/mensagem mais alto que a tela.
  // Carregar mensagens antigas (o primeiro item muda, o último não) não rola.
  useLayoutEffect(() => {
    const firstKey = timeline[0]?.key ?? null;
    const prependedOnly = firstKeyRef.current !== null && firstKey !== firstKeyRef.current;
    firstKeyRef.current = firstKey;
    if (prependedOnly) return;
    const scroller = endRef.current?.parentElement;
    if (!scroller) return;
    const userActed = actedTickRef.current !== userActionTick;
    actedTickRef.current = userActionTick;
    const items = scroller.querySelectorAll<HTMLElement>("[data-timeline-item]");
    const lastEl = items[items.length - 1];
    const mode = newContentScroll({
      followBottom: followRef.current,
      userActed,
      lastItemHeight: lastEl?.offsetHeight ?? 0,
      viewHeight: scroller.clientHeight,
    });
    if (mode === "bottom") scroller.scrollTop = scroller.scrollHeight;
    else if (mode === "item-top" && lastEl) {
      scroller.scrollTop = Math.max(0, lastEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 12);
      followRef.current = false;
    }
  }, [lastSignature, timeline, userActionTick]);

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
        <div role="alert" className="mx-2 mt-2 flex flex-wrap items-start gap-2 rounded-card border border-semantic-error/30 bg-semantic-error/10 px-3 py-2 text-sm text-text-primary">
          <p className="min-w-0 flex-1 basis-48 pt-1.5">{error}</p>
          <div className="flex shrink-0 items-center">
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
        </div>
      )}
      {nextStep && !composerDisabled && <NextStepBar {...nextStep} disabled={nextStep.disabled || typing} />}
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
        onAttach={onAttach}
        onMic={onMic}
        attachDisabled={!onAttach}
        micDisabled={!onMic}
        attachLabel="Enviar site, PDF ou imagem"
        micLabel="Gravar áudio"
        className="pb-safe"
      />
    </div>
  );

  return (
    <div className="flex h-screen flex-col bg-surface-base supports-[height:100dvh]:h-[100dvh]">
      {/* Com a tela de teste aberta, no celular ela é tela cheia (o cabeçalho dela tem a saída). */}
      <header className={cn("flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-1.5 md:px-4", takeover && "hidden lg:flex")}>
        <Link
          to="/"
          aria-label="HNBCRM, página inicial"
          className="inline-flex min-h-11 items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <BrandLogo size="sm" decorative />
          <span className="ml-2 hidden font-display text-base font-bold text-text-primary sm:inline">HNBCRM</span>
        </Link>
        <div className="flex-1" />
        {preview && !takeover && (
          <Button type="button" variant="secondary" size="sm" className="shrink-0 whitespace-nowrap lg:hidden" onClick={() => setSheetOpen(true)}>
            <ListChecks className="size-4" aria-hidden="true" />
            Sua operação
          </Button>
        )}
        {appHref && (
          <Link
            to={appHref}
            aria-label="Ir para o CRM"
            className={cn(buttonClassName("ghost", "sm"), "min-h-11 min-w-11 text-caption sm:text-sm")}
          >
            <LayoutDashboard className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Ir para o CRM</span>
          </Link>
        )}
        <Link
          to={formHref}
          onClick={onPreferForm}
          className={cn(buttonClassName("ghost", "sm"), "min-h-11 min-w-11 shrink-0 whitespace-nowrap text-caption sm:text-sm")}
        >
          <ClipboardList className="size-4 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline">Prefiro preencher um formulário</span>
          {/* No celular o cabeçalho tem "Sua operação": o formulário fica só no ícone (rótulo para leitor de tela). */}
          <span className="sr-only sm:hidden">Prefiro preencher um formulário</span>
        </Link>
        <PublicThemeButton />
        {onRestart && (
          <Menu
            ariaLabel="Opções da conversa"
            items={[{ id: "restart", label: "Recomeçar a conversa", icon: <RotateCcw className="size-4" aria-hidden="true" />, onSelect: onRestart }]}
            trigger={(props) => (
              <Button {...props} type="button" variant="ghost" size="sm" iconOnly aria-label="Mais opções da conversa" className="min-h-11 min-w-11 shrink-0">
                <MoreVertical className="size-4" aria-hidden="true" />
              </Button>
            )}
          />
        )}
      </header>

      <main className="flex min-h-0 flex-1">
        <h1 className="sr-only">Configure o seu CRM conversando com o Copiloto</h1>
        {takeover && <div className="mx-auto flex min-h-0 w-full min-w-0 max-w-4xl flex-1 flex-col lg:p-4">{takeover}</div>}
        <div hidden={!!takeover} className={cn("flex min-h-0 min-w-0 flex-1 flex-col lg:p-4", takeover && "hidden")}>
          <ChatWindow
            title="Copiloto HNBCRM"
            subtitle="online"
            typing={typing}
            typingLabel={status || "digitando…"}
            live
            label="Conversa com o Copiloto HNBCRM"
            subheader={<StageProgress progress={progress} />}
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
            <p role="note" className="mx-2 rounded-card bg-surface-sunken px-3 py-2 text-caption text-text-muted">
              {AI_PROCESSING_NOTICE}
            </p>
            {intro}
            {timeline.map((item) => (
              <div key={item.key} data-timeline-item>
                <MessageItem
                  item={item}
                  blockCtx={blockCtx}
                  isLatest={item.key === latestAssistantKey && item.key === last?.key}
                  superseded={superseded}
                />
              </div>
            ))}
            {tail}
            {showTypingBubble && <TypingDots label={status || "digitando…"} />}
            <div ref={endRef} aria-hidden="true" />
          </ChatWindow>
        </div>
        {preview && !takeover && (
          <div className="hidden w-[22rem] shrink-0 border-l border-border-subtle bg-surface-sunken lg:flex lg:flex-col xl:w-[26rem]">
            {preview}
          </div>
        )}
      </main>
      {preview && (
        <Modal open={sheetOpen} onClose={() => setSheetOpen(false)} title="Sua operação">
          {previewSheet ?? preview}
        </Modal>
      )}
    </div>
  );
}
