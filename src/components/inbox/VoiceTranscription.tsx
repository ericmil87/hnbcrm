import { useState } from "react";
import { Loader2, FileText, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TranscriptionMeta } from "./types";

interface VoiceTranscriptionProps {
  transcription: TranscriptionMeta | null;
  /** Bubble background — keeps text legible on colored outbound bubbles. */
  variant: "inbound" | "outbound";
  /** True while the transcribe action is in flight (local optimistic state). */
  transcribing: boolean;
  onTranscribe: () => void;
}

const COLLAPSE_LIMIT = 160;

export function VoiceTranscription({
  transcription,
  variant,
  transcribing,
  onTranscribe,
}: VoiceTranscriptionProps) {
  const [expanded, setExpanded] = useState(false);
  const outbound = variant === "outbound";
  const muted = outbound ? "text-white/70" : "text-text-muted";

  const status = transcription?.status;

  // In-flight (local) or backend-reported pending → spinner.
  if (transcribing || status === "pending") {
    return (
      <div className={cn("flex items-center gap-1.5 text-xs italic", muted)}>
        <Loader2 size={13} className="animate-spin shrink-0" />
        Transcrevendo…
      </div>
    );
  }

  if (status === "done" && transcription?.text) {
    const text = transcription.text.trim();
    const isLong = text.length > COLLAPSE_LIMIT;
    const shown = !isLong || expanded ? text : `${text.slice(0, COLLAPSE_LIMIT)}…`;
    return (
      <div className="flex flex-col gap-0.5">
        <p
          className={cn(
            "text-xs italic whitespace-pre-wrap break-words",
            outbound ? "text-white/85" : "text-text-secondary"
          )}
        >
          {shown}
        </p>
        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className={cn(
              "flex items-center gap-0.5 self-start text-[11px] font-medium",
              outbound ? "text-white/70 hover:text-white" : "text-brand-400 hover:text-brand-500"
            )}
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {expanded ? "Ver menos" : "Ver mais"}
          </button>
        )}
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div className="flex items-center gap-2">
        <span className={cn("text-xs italic", outbound ? "text-white/70" : "text-semantic-error")}>
          Falha na transcrição
        </span>
        <button
          type="button"
          onClick={onTranscribe}
          className={cn(
            "flex items-center gap-1 text-[11px] font-medium",
            outbound ? "text-white/80 hover:text-white" : "text-brand-400 hover:text-brand-500"
          )}
        >
          <RefreshCw size={12} />
          Tentar de novo
        </button>
      </div>
    );
  }

  // "skipped" — nothing to transcribe (e.g. silent/short); stay quiet.
  if (status === "skipped") return null;

  // No transcription yet → subtle CTA.
  return (
    <button
      type="button"
      onClick={onTranscribe}
      className={cn(
        "flex items-center gap-1 self-start text-[11px] font-medium",
        outbound ? "text-white/80 hover:text-white" : "text-brand-400 hover:text-brand-500"
      )}
    >
      <FileText size={12} />
      Transcrever
    </button>
  );
}
