import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Bot, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
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
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointer = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

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
      toast.error(mutationErrorMessage(e, "Falha ao cancelar o follow-up"));
    } finally {
      setCancelingId(null);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full bg-purple-500/10 px-2.5 py-1 text-xs font-medium text-purple-300 transition-colors hover:bg-purple-500/20"
      >
        <Bot size={12} />
        {label}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Follow-ups da IA nesta conversa"
          className="absolute left-0 top-full z-40 mt-2 w-[calc(100vw-2rem)] max-w-xs overflow-hidden rounded-xl border border-border bg-surface-overlay shadow-elevated md:left-auto md:right-0"
        >
          <ul className="max-h-72 divide-y divide-border overflow-y-auto">
            {items.map((item) => (
              <li key={item._id} className="space-y-1.5 p-3">
                <p className="truncate text-sm font-medium text-text-primary" title={item.title}>
                  {item.title}
                </p>
                <p className="text-xs text-text-muted">{formatFollowUpDueAt(item.dueAt)}</p>
                {item.note && (
                  <p
                    className="truncate text-xs italic text-text-secondary"
                    title={item.note}
                  >
                    &ldquo;{item.note}&rdquo;
                  </p>
                )}
                <div className="flex items-center gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => handleOpenTask(item.taskId)}
                    className="text-xs font-medium text-brand-500 transition-colors hover:text-brand-400"
                  >
                    Abrir tarefa
                  </button>
                  <button
                    type="button"
                    disabled={cancelingId === item._id}
                    onClick={() => void handleCancel(item._id)}
                    className={cn(
                      "inline-flex items-center gap-1 text-xs font-medium text-text-muted transition-colors hover:text-semantic-error",
                      cancelingId === item._id && "opacity-60"
                    )}
                  >
                    <X size={11} />
                    {cancelingId === item._id ? "Cancelando…" : "Cancelar"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
