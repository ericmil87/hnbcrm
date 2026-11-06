import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Sparkles, UserRoundCheck, Undo2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { AiInstructionPopover } from "@/components/inbox/AiDraftCard";
import { AiStatusChip } from "@/components/inbox/AiStatusChip";
import { Popover } from "@/components/ui/Popover";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { mutationErrorMessage } from "@/lib/errors";
import { formatFollowUpDueAt } from "@/lib/followUp";
import { aiStateChipInfo, type AiConvState } from "@/lib/inboxState";
import { cn } from "@/lib/utils";

interface AiControlMenuProps {
  conversationId: Id<"conversations">;
  aiPausedUntil?: number;
  hasPendingDraft: boolean;
  aiState: AiConvState;
  /** Sem `inbox:reply` o menu só informa o estado. */
  canReply: boolean;
}

const rowClass =
  "flex w-full min-h-11 items-center gap-2.5 px-4 py-2.5 text-left text-sm text-text-primary transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500";

/**
 * Controle da IA no cabeçalho da conversa: um único ícone (cor = estado) que
 * abre o estado, "Assumir conversa" / "Devolver à IA", "Pedir resposta
 * sugerida" e o follow-up pendente. No desktop mostra também o rótulo.
 */
export function AiControlMenu({ conversationId, aiPausedUntil, hasPendingDraft, aiState, canReply }: AiControlMenuProps) {
  const paused = aiPausedUntil !== undefined && aiPausedUntil > Date.now();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [open, setOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);

  const assume = useMutation(api.conversations.assumeConversation);
  const requestDraft = useMutation(api.attendant.requestAiDraft);
  const returnToAi = useMutation(api.attendant.returnToAi);
  const followUps = useQuery(api.attendantFollowUp.listForConversation, { conversationId });

  const processing = aiState?.status === "pending" || aiState?.status === "processing";
  const waiting =
    aiStateChipInfo(aiState)?.tone === "waiting" && !(paused && aiState?.reason === "ia_pausada");
  const stateText = paused ? "IA pausada nesta conversa" : "IA ativa nesta conversa";
  const triggerLabel = paused ? "IA pausada" : "IA ativa";

  const handleAssume = () => {
    setOpen(false);
    toast.promise(assume({ conversationId }), {
      loading: "Assumindo…",
      success: "Conversa assumida. IA pausada",
      error: (e) => mutationErrorMessage(e, "Não foi possível assumir a conversa. Tente de novo."),
    });
  };
  const handleReturn = (instruction?: string) => {
    setReturnOpen(false);
    toast.promise(returnToAi({ conversationId, ...(instruction ? { instruction } : {}) }), {
      loading: "Devolvendo…",
      success: "Conversa devolvida à IA",
      error: (e) => mutationErrorMessage(e, "Não foi possível devolver à IA. Tente de novo."),
    });
  };
  const handleAsk = (instruction?: string) => {
    setAskOpen(false);
    toast.promise(requestDraft({ conversationId, ...(instruction ? { instruction } : {}) }), {
      loading: "Pedindo à IA…",
      success: "Pedido enviado. A IA vai propor uma resposta",
      error: (e) => mutationErrorMessage(e, "Não foi possível pedir a sugestão. Tente de novo."),
    });
  };

  const followUpText =
    followUps && followUps.length > 0
      ? followUps.length === 1
        ? `Follow-up da IA: ${formatFollowUpDueAt(followUps[0].dueAt)}`
        : `${followUps.length} follow-ups da IA`
      : null;

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${waiting ? "IA em espera" : triggerLabel}. Abrir controles da IA`}
        className={cn(
          "relative inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full px-0 text-xs font-medium transition-colors hover:bg-surface-overlay md:h-9 md:min-w-0 md:px-3 md:bg-surface-overlay/60",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
          paused ? "text-text-muted" : "text-ai-400",
          processing && "motion-safe:animate-pulse",
          open && "bg-surface-overlay"
        )}
      >
        <Sparkles size={20} aria-hidden className="md:hidden" />
        <Sparkles size={14} aria-hidden className="hidden md:block" />
        <span className="hidden md:inline">{waiting ? "IA em espera" : triggerLabel}</span>
        {waiting && (
          <span
            aria-hidden
            className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-semantic-warning md:static md:right-auto md:top-auto"
          />
        )}
      </button>

      <Popover
        open={open}
        onOpenChange={setOpen}
        anchor={anchor}
        align="end"
        sheet={isMobile}
        role="dialog"
        aria-label="Controles da IA"
        className={cn("py-2", !isMobile && "w-72")}
      >
        <div className="flex flex-col">
          <div className="flex items-center gap-2 px-4 pb-2 pt-1 text-sm font-medium text-text-primary">
            <Sparkles size={16} aria-hidden className={paused ? "text-text-muted" : "text-ai-400"} />
            {stateText}
          </div>
          <div className="px-4 pb-2 empty:hidden">
            <AiStatusChip state={aiState} paused={paused} />
          </div>
          {canReply && (
            <div className="border-t border-border pt-1">
              {paused ? (
                <button
                  type="button"
                  className={rowClass}
                  onClick={() => {
                    setOpen(false);
                    setReturnOpen(true);
                  }}
                >
                  <Undo2 size={16} aria-hidden />
                  Devolver à IA
                </button>
              ) : (
                <>
                  <button type="button" className={rowClass} onClick={handleAssume}>
                    <UserRoundCheck size={16} aria-hidden />
                    Assumir conversa
                  </button>
                  {!hasPendingDraft && (
                    <button
                      type="button"
                      className={rowClass}
                      onClick={() => {
                        setOpen(false);
                        setAskOpen(true);
                      }}
                    >
                      <Sparkles size={16} aria-hidden />
                      Pedir resposta sugerida
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {followUpText && (
            <p className="border-t border-border px-4 pt-2 text-xs text-text-muted">{followUpText}</p>
          )}
        </div>
      </Popover>

      <AiInstructionPopover
        open={returnOpen}
        anchor={anchor}
        title="Devolver a conversa à IA"
        placeholder='Instrução para a IA (opcional): responda o que ela precisa — ex. "o Pix é financeiro@empresa.com e o valor é R$ 150" — ou peça uma ação: "faça follow-up amanhã"'
        submitLabel="Devolver"
        onSubmit={handleReturn}
        onClose={() => setReturnOpen(false)}
      />
      <AiInstructionPopover
        open={askOpen}
        anchor={anchor}
        title="Pedir uma sugestão de resposta"
        placeholder="Instrução para a IA (opcional): ex. responda a última dúvida e proponha uma call"
        submitLabel="Pedir"
        onSubmit={handleAsk}
        onClose={() => setAskOpen(false)}
      />
    </>
  );
}
