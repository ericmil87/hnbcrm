import { useEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { Reply, Forward, FileText, ScanText, Languages, Copy, ClipboardCopy, History } from "lucide-react";
import { Popover } from "@/components/ui/Popover";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/utils";
import { INSTAGRAM_REACTION_HINT } from "@/lib/channelCapabilities";

// Reações são conteúdo do usuário: emoji unicode aqui é intencional (os
// ícones da interface continuam lucide).
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

export interface CopyItem {
  label: string;
  value: string;
  done: string;
}

interface MessageActionsBarProps {
  open: boolean;
  onClose: () => void;
  /** Gatilho (botão do hover) ou a própria bolha (toque longo): recebe o foco de volta. */
  anchor: RefObject<HTMLElement | null>;
  /** Whether the current user can reply/react/forward (inbox reply permission). */
  canInteract: boolean;
  activeEmoji?: string | null;
  /** Ausente quando o canal não aceita responder com citação (ex.: Messenger). */
  onReply?: () => void;
  /** Ausente quando o canal não envia reação (Instagram/Messenger, F2). */
  onReact?: (emoji: string) => void;
  /**
   * Ausente numa sala de GRUPO: encaminhar uma mensagem que dezenas de
   * terceiros escreveram é vazamento com um clique, e o servidor recusa
   * (review de correção nº 1).
   */
  onForward?: () => void;
  /** Present only for a voice note that still needs a transcription. */
  onTranscribe?: () => void;
  /** Present only for an image that still needs the AI reading (vision on). */
  onDescribeImage?: () => void;
  /** Tradução: "Traduzir mesmo assim" (recebida pulada ou nunca processada). */
  onTranslate?: () => void;
  /** Mensagem editada com versões anteriores: abre/fecha a lista. */
  onToggleHistory?: () => void;
  historyOpen?: boolean;
  /** Texto(s) copiáveis: o texto da bolha, ou as duas versões de uma tradução. */
  copyItems?: CopyItem[];
  onCopy?: (item: CopyItem) => void;
  /** Lado da bolha: o popover do desktop alinha com ela. */
  align?: "start" | "end";
  /** Emojis oferecidos (Instagram: só o coração); null = todos. */
  reactionEmojis?: string[] | null;
}

interface ActionItem {
  id: string;
  label: string;
  icon: ReactNode;
  run: () => void;
}

const ITEM =
  "flex w-full min-h-11 items-center gap-3 px-4 py-2.5 text-left text-sm text-text-primary transition-colors md:min-h-9 md:px-3 md:py-2 hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500";

/**
 * Ações de uma mensagem (como o WhatsApp): fileira de reações rápidas e a
 * lista (responder, encaminhar, copiar, transcrever, ler imagem, traduzir,
 * histórico). Folha inferior no celular (aberta pelo toque longo), popover
 * ancorado no desktop (botão que aparece no hover/foco da bolha).
 * `role="menu"` com setas/Home/End; Esc e clique fora fecham.
 */
export function MessageActionsBar({
  open,
  onClose,
  anchor,
  canInteract,
  activeEmoji,
  onReply,
  onReact,
  onForward,
  onTranscribe,
  onDescribeImage,
  onTranslate,
  onToggleHistory,
  historyOpen = false,
  copyItems,
  onCopy,
  align = "start",
  reactionEmojis = null,
}: MessageActionsBarProps) {
  const isMobile = useMediaQuery("(max-width: 767px)");
  const listRef = useRef<HTMLDivElement>(null);

  const buttons = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);

  useEffect(() => {
    if (!open) return;
    // O Popover monta no portal no mesmo commit; foca no próximo frame.
    const id = requestAnimationFrame(() => buttons()[0]?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const close = () => {
    onClose();
    anchor.current?.focus({ preventScroll: true });
  };
  const select = (run: () => void) => () => {
    close();
    run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = buttons();
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = (i + 1) % list.length;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Tab") {
      e.preventDefault();
      close();
      return;
    }
    if (next === null) return;
    e.preventDefault();
    list[next].focus();
  };

  const items: ActionItem[] = [];
  if (canInteract && onReply) items.push({ id: "reply", label: "Responder", icon: <Reply size={18} />, run: onReply });
  if (canInteract && onForward) items.push({ id: "forward", label: "Encaminhar", icon: <Forward size={18} />, run: onForward });
  if (onCopy)
    copyItems?.forEach((item, i) =>
      items.push({
        id: `copy-${i}`,
        label: item.label,
        icon: i === 0 ? <Copy size={18} /> : <ClipboardCopy size={18} />,
        run: () => onCopy(item),
      })
    );
  if (onTranscribe) items.push({ id: "transcribe", label: "Transcrever áudio", icon: <FileText size={18} />, run: onTranscribe });
  if (onDescribeImage) items.push({ id: "vision", label: "Ler imagem", icon: <ScanText size={18} />, run: onDescribeImage });
  if (onTranslate) items.push({ id: "translate", label: "Traduzir mesmo assim", icon: <Languages size={18} />, run: onTranslate });
  if (onToggleHistory)
    items.push({
      id: "history",
      label: historyOpen ? "Ocultar versões anteriores" : "Ver versões anteriores",
      icon: <History size={18} />,
      run: onToggleHistory,
    });

  const emojis = canInteract && onReact ? reactionEmojis ?? [...QUICK_REACTIONS] : [];

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      anchor={anchor}
      side="bottom"
      align={align}
      sheet={isMobile}
      className={cn(!isMobile && "min-w-52 max-w-xs")}
    >
      <div
        ref={listRef}
        role="menu"
        aria-label="Ações da mensagem"
        onKeyDown={onKeyDown}
        className={cn("py-1", isMobile && "pt-3")}
      >
        {emojis.length > 0 && (
          <div
            className={cn(
              "flex items-center gap-1 px-2 pb-1",
              isMobile ? "justify-around" : "justify-start",
              items.length > 0 && "mb-1 border-b border-border"
            )}
          >
            {emojis.map((emoji) => (
              <button
                key={emoji}
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={select(() => onReact?.(emoji))}
                aria-label={activeEmoji === emoji ? `Remover reação ${emoji}` : `Reagir com ${emoji}`}
                aria-pressed={activeEmoji === emoji}
                className={cn(
                  "flex size-11 items-center justify-center rounded-full text-2xl leading-none transition-transform md:size-9 md:text-xl",
                  "hover:bg-surface-raised motion-safe:hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                  activeEmoji === emoji && "bg-brand-500/15"
                )}
              >
                {emoji}
              </button>
            ))}
            {reactionEmojis && <span className="px-2 text-caption text-text-secondary">{INSTAGRAM_REACTION_HINT}</span>}
          </div>
        )}
        {items.map((item) => (
          <button key={item.id} type="button" role="menuitem" tabIndex={-1} onClick={select(item.run)} className={ITEM}>
            <span className="shrink-0 text-text-secondary" aria-hidden>
              {item.icon}
            </span>
            {item.label}
          </button>
        ))}
      </div>
    </Popover>
  );
}
