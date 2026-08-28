import { useState } from "react";
import { Reply, Smile, Forward, FileText, ScanText } from "lucide-react";
import { cn } from "@/lib/utils";
import { ReactionPicker } from "./ReactionPicker";

interface MessageActionsBarProps {
  /** Whether the current user can reply/react/forward (inbox reply permission). */
  canInteract: boolean;
  activeEmoji?: string | null;
  onReply: () => void;
  onReact: (emoji: string) => void;
  onForward: () => void;
  /** Present only for a voice note that still needs a transcription. */
  onTranscribe?: () => void;
  /** Present only for an image that still needs the AI reading (vision on). */
  onDescribeImage?: () => void;
  /** Which side the bubble sits on — drives picker alignment. */
  align?: "start" | "end";
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
  align = "start",
  className,
}: MessageActionsBarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const handleReact = (emoji: string) => {
    setPickerOpen(false);
    onReact(emoji);
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
          <button type="button" onClick={onReply} className={BTN} aria-label="Responder">
            <Reply size={16} />
          </button>
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
          <button type="button" onClick={onForward} className={BTN} aria-label="Encaminhar">
            <Forward size={16} />
          </button>
        </>
      )}
      {onTranscribe && (
        <button
          type="button"
          onClick={onTranscribe}
          className={BTN}
          aria-label="Transcrever áudio"
          title="Transcrever"
        >
          <FileText size={16} />
        </button>
      )}

      {onDescribeImage && (
        <button
          type="button"
          onClick={onDescribeImage}
          className={BTN}
          aria-label="Ler imagem"
          title="Ler imagem"
        >
          <ScanText size={16} />
        </button>
      )}

      {pickerOpen && (
        <ReactionPicker
          activeEmoji={activeEmoji}
          onSelect={handleReact}
          onClose={() => setPickerOpen(false)}
          placement="top"
          align={align}
        />
      )}
    </div>
  );
}
