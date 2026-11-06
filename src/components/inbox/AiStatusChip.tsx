import { cn } from "@/lib/utils";
import { aiStateChipInfo, type AiConvState } from "@/lib/inboxState";

interface AiStatusChipProps {
  /** Estado do atendente nesta conversa (`attendant.getConversationAiState`). */
  state: AiConvState;
  /** A conversa já mostra "IA pausada": só o motivo "IA pausada" some (outros motivos, como limite ou horário, seguem visíveis). */
  paused?: boolean;
  className?: string;
}

/**
 * Chip "IA preparando resposta…" / "IA em espera: motivo". Some quando o item
 * da fila terminou ou já foi superado por uma mensagem mais nova.
 */
export function AiStatusChip({ state, paused = false, className }: AiStatusChipProps) {
  const info = aiStateChipInfo(state);
  if (!info || (paused && info.tone === "waiting" && state?.reason === "ia_pausada")) return null;
  return (
    <span
      role="status"
      data-tone={info.tone}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        info.tone === "processing"
          ? "bg-brand-500/10 text-brand-400"
          : "bg-surface-overlay text-text-muted",
        className
      )}
    >
      {info.label}
    </span>
  );
}
