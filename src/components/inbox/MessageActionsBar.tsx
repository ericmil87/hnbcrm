import { Tooltip } from "@/components/ui/Tooltip";
import { useState } from "react";
import { Reply, Smile, Forward, FileText, ScanText, Languages, Copy, ClipboardCopy } from "lucide-react";
import { cn } from "@/lib/utils";
import { ReactionPicker } from "./ReactionPicker";

interface MessageActionsBarProps {
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
  /** Tradução feita: copiar cada uma das duas versões. */
  copyItems?: { label: string; value: string; done: string }[];
  onCopy?: (item: { label: string; value: string; done: string }) => void;
  /** Which side the bubble sits on — drives picker alignment. */
  align?: "start" | "end";
  /** Emojis oferecidos no picker (Instagram: só o coração); null = todos. */
  reactionEmojis?: string[] | null;
  className?: string;
}

const BTN =
  "flex items-center justify-center h-8 w-8 rounded-full text-text-secondary hover:text-text-primary hover:bg-surface-raised transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500";

export function MessageActionsBar({
  canInteract,
  activeEmoji,
  onReply,
  onReact,
  onForward,
  onTranscribe,
  onDescribeImage,
  onTranslate,
  copyItems,
  onCopy,
  align = "start",
  reactionEmojis = null,
  className,
}: MessageActionsBarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const handleReact = (emoji: string) => {
    setPickerOpen(false);
    onReact?.(emoji);
  };

  return (
    <div
      className={cn(
        "relative flex items-center gap-0.5 p-0.5 rounded-full",
        "bg-surface-overlay border border-border shadow-md",
        className
      )}
    >
      {canInteract && (
        <>
          {onReply && (
            <button type="button" onClick={onReply} className={BTN} aria-label="Responder">
              <Reply size={16} />
            </button>
          )}
          {onReact && (
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              className={cn(BTN, pickerOpen && "text-brand-400 bg-surface-raised")}
              aria-label="Reagir"
              aria-haspopup="menu"
              aria-expanded={pickerOpen}
            >
              <Smile size={16} />
            </button>
          )}
          {onForward && (
            <button type="button" onClick={onForward} className={BTN} aria-label="Encaminhar">
              <Forward size={16} />
            </button>
          )}
        </>
      )}
      {onTranscribe && (
        <Tooltip content="Transcrever áudio">
          <button
            type="button"
            onClick={onTranscribe}
            className={BTN}
            aria-label="Transcrever áudio"
          >
            <FileText size={16} />
          </button>
        </Tooltip>
      )}

      {onDescribeImage && (
        <Tooltip content="Ler imagem">
          <button
            type="button"
            onClick={onDescribeImage}
            className={BTN}
            aria-label="Ler imagem"
          >
            <ScanText size={16} />
          </button>
        </Tooltip>
      )}

      {onTranslate && (
        <Tooltip content="Traduzir mesmo assim">
          <button type="button" onClick={onTranslate} className={BTN} aria-label="Traduzir mesmo assim">
            <Languages size={16} />
          </button>
        </Tooltip>
      )}

      {onCopy &&
        copyItems?.map((item, i) => (
          <Tooltip key={item.label} content={item.label}>
            <button type="button" onClick={() => onCopy(item)} className={BTN} aria-label={item.label}>
              {i === 0 ? <Copy size={16} /> : <ClipboardCopy size={16} />}
            </button>
          </Tooltip>
        ))}

      {pickerOpen && (
        <ReactionPicker
          activeEmoji={activeEmoji}
          onSelect={handleReact}
          onClose={() => setPickerOpen(false)}
          placement="top"
          align={align}
          emojis={reactionEmojis}
        />
      )}
    </div>
  );
}
