import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Bot, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Popover } from "@/components/ui/Popover";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { TAB_ROUTES } from "@/lib/routes";
import { mutationErrorMessage } from "@/lib/errors";
import { formatFollowUpDueAt } from "@/lib/followUp";

/**
 * Chip "Follow-up da IA: amanhã 09:00" no header da conversa (v0.60). Só
 * lista o que ainda está "da IA" (`listForConversation` já filtra por
 * scheduled/queued/drafted). Clicar abre um popover pequeno com cada
 * follow-up pendente da conversa — funciona igual em mobile e desktop (o
 * mesmo molde de `AiInstructionPopover`).
 */
export function FollowUpChip({ conversationId }: { conversationId: Id<"conversations"> }) {
  const navigate = useNavigate();
  const items = useQuery(api.attendantFollowUp.listForConversation, { conversationId });
  const cancelAuto = useMutation(api.attendantFollowUp.cancelAuto);
  const [open, setOpen] = useState(false);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const isMobile = useMediaQuery("(max-width: 767px)");

  if (!items || items.length === 0) return null;

  const label =
    items.length === 1
      ? `Follow-up da IA: ${formatFollowUpDueAt(items[0].dueAt)}`
      : `${items.length} follow-ups da IA`;

  const handleOpenTask = (taskId: string) => {
    setOpen(false);
    navigate(`${TAB_ROUTES.tasks}?task=${taskId}`);
  };

  const handleCancel = async (followUpId: Id<"aiFollowUps">) => {
    setCancelingId(followUpId);
    try {
      await cancelAuto({ followUpId });
      toast.success("Execução automática desligada");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível cancelar o follow-up."));
    } finally {
      setCancelingId(null);
    }
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-ai-500/10 px-2.5 text-xs font-medium text-ai-300 transition-colors hover:bg-ai-500/20 coarse:h-9"
      >
        <Bot size={12} aria-hidden />
        {label}
      </button>

      <Popover
        open={open}
        onOpenChange={setOpen}
        anchor={anchor}
        align="start"
        sheet={isMobile}
        role="dialog"
        aria-label="Follow-ups da IA nesta conversa"
        className={cn(!isMobile && "w-80 max-w-[calc(100vw-1rem)]")}
      >
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item._id} className="space-y-1.5 p-3">
              <p className="truncate text-sm font-medium text-text-primary" title={item.title}>
                {item.title}
              </p>
              <p className="text-xs text-text-muted">{formatFollowUpDueAt(item.dueAt)}</p>
              {item.note && (
                <p className="truncate text-xs italic text-text-secondary" title={item.note}>
                  &ldquo;{item.note}&rdquo;
                </p>
              )}
              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => handleOpenTask(item.taskId)}
                  className="min-h-11 text-xs font-medium text-brand-500 transition-colors hover:text-brand-400 md:min-h-0"
                >
                  Abrir tarefa
                </button>
                <button
                  type="button"
                  disabled={cancelingId === item._id}
                  onClick={() => void handleCancel(item._id)}
                  className={cn(
                    "inline-flex min-h-11 items-center gap-1 text-xs font-medium text-text-muted transition-colors hover:text-semantic-error md:min-h-0",
                    cancelingId === item._id && "opacity-60"
                  )}
                >
                  <X size={11} aria-hidden />
                  {cancelingId === item._id ? "Cancelando…" : "Cancelar"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Popover>
    </>
  );
}
