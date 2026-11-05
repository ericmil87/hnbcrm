import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation } from "convex/react";
import { Bot, MessageSquare, Send, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { TAB_ROUTES } from "@/lib/routes";
import { mutationErrorMessage } from "@/lib/errors";
import { followUpHeadline, humanizeFollowUpReason, type FollowUpStatus } from "@/lib/followUp";


export type FollowUpSummary = {
  _id: Id<"aiFollowUps">;
  status: string;
  dueAt: number;
  note: string | null;
  reason: string | null;
  conversationId: Id<"conversations">;
  channelLabel?: string | null;
};

/**
 * Card "Follow-up da IA" logo abaixo do título/badges. Três desfechos:
 *  - `undefined` (query ainda carregando) → nada, evita piscar;
 *  - `null` (tarefa sem follow-up) → oferece "Pedir para a IA executar"
 *    quando a tarefa está pendente, ligada a um lead e atribuída a um
 *    atendente IA ativo; senão fica em silêncio;
 *  - objeto → estado em linguagem clara + ações (`getTask`/`getForTask` usam
 *    `returns: v.any()`, então `task` chega solto — só lemos os campos que
 *    precisamos).
 */
export function FollowUpCard({
  followUp,
  task,
  onOpenConversation,
  runBusy,
  cancelBusy,
  cancelConfirm,
  onRunNow,
  onCancelAutoClick,
  onCancelAutoConfirm,
  onCancelAutoAbort,
  adoptBusy,
  onAdopt,
}: {
  followUp: FollowUpSummary | null | undefined;
  task: {
    status: string;
    leadId?: Id<"leads"> | null;
    assignee?: { type?: string; status?: string; agentProfile?: { kind?: string } } | null;
  };
  onOpenConversation: (conversationId: Id<"conversations">) => void;
  runBusy: boolean;
  cancelBusy: boolean;
  cancelConfirm: boolean;
  onRunNow: () => void;
  onCancelAutoClick: () => void;
  onCancelAutoConfirm: () => void;
  onCancelAutoAbort: () => void;
  adoptBusy: boolean;
  onAdopt: () => void;
}) {
  if (followUp === undefined) return null;

  const canAdopt =
    task.status === "pending" &&
    !!task.leadId &&
    task.assignee?.type === "ai" &&
    task.assignee?.status === "active" &&
    task.assignee?.agentProfile?.kind === "attendant";

  if (followUp === null) {
    if (!canAdopt) return null;
    return (
      <div className="px-4 pt-1">
        <button
          type="button"
          onClick={onAdopt}
          disabled={adoptBusy}
          className="inline-flex min-h-11 items-center gap-1.5 text-xs font-medium text-brand-500 hover:text-brand-400 transition-colors disabled:opacity-60"
        >
          <Bot size={13} />
          {adoptBusy ? "Pedindo…" : "Pedir para a IA executar"}
        </button>
      </div>
    );
  }

  const status = followUp.status as FollowUpStatus;
  const headline = followUpHeadline(status, followUp.dueAt);
  const isActive = status === "scheduled" || status === "queued" || status === "drafted";
  const isNeedsHuman = status === "needs_human";
  const reasonLabel = humanizeFollowUpReason(followUp.reason, followUp.channelLabel);

  return (
    <div className="px-4 pt-1">
      <div
        className={cn(
          "rounded-lg border p-3 space-y-2",
          isNeedsHuman
            ? "border-semantic-warning/40 bg-semantic-warning/10"
            : "border-border bg-surface-sunken"
        )}
      >
        <div className="flex items-start gap-2">
          <Sparkles
            size={16}
            className={cn(
              "shrink-0 mt-0.5",
              isNeedsHuman ? "text-semantic-warning" : "text-ai-400"
            )}
          />
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "text-sm font-medium break-words",
                isNeedsHuman ? "text-semantic-warning" : "text-text-primary"
              )}
            >
              {headline}
              {isNeedsHuman && reasonLabel ? `: ${reasonLabel}` : ""}
            </p>
            {followUp.note && (
              <p className="text-xs text-text-secondary mt-1 break-words">
                Nota da IA: &ldquo;{followUp.note}&rdquo;
              </p>
            )}
            {!isNeedsHuman && reasonLabel && (
              <p className="text-xs text-text-muted mt-1 break-words">Motivo: {reasonLabel}</p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {(status === "drafted" || status === "done") && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onOpenConversation(followUp.conversationId)}
            >
              <MessageSquare size={13} aria-hidden="true" />
              {status === "drafted" ? "Ver conversa" : "Ver mensagem"}
            </Button>
          )}
          {status === "scheduled" && (
            <Button type="button" variant="secondary" size="sm" disabled={runBusy} onClick={onRunNow}>
              <Send size={13} aria-hidden="true" />
              {runBusy ? "Executando…" : "Executar agora"}
            </Button>
          )}
          {/* Desligou a execução automática (ou a IA não conseguiu) e a tarefa
              voltou para o atendente: dá para religar. */}
          {(status === "canceled" || status === "needs_human") && canAdopt && (
            <Button type="button" variant="secondary" size="sm" disabled={adoptBusy} onClick={onAdopt}>
              <Bot size={13} aria-hidden="true" />
              {adoptBusy ? "Pedindo…" : "Pedir para a IA executar"}
            </Button>
          )}
          {isActive && !cancelConfirm && (
            <button
              type="button"
              onClick={onCancelAutoClick}
              className="min-h-11 text-xs text-text-muted hover:text-semantic-error transition-colors"
            >
              Não executar automaticamente
            </button>
          )}
          {isActive && cancelConfirm && (
            <span className="inline-flex flex-wrap items-center gap-2 text-xs text-text-secondary">
              Desligar a execução automática?
              <button
                type="button"
                disabled={cancelBusy}
                onClick={onCancelAutoConfirm}
                className="min-h-11 font-medium text-semantic-error hover:text-semantic-error/80 disabled:opacity-60"
              >
                {cancelBusy ? "Desligando…" : "Confirmar"}
              </button>
              <button
                type="button"
                onClick={onCancelAutoAbort}
                className="min-h-11 text-text-muted hover:text-text-secondary"
              >
                Voltar
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

interface TaskAiFollowUpProps {
  taskId: Id<"tasks">;
  followUp: FollowUpSummary | null | undefined;
  task: Parameters<typeof FollowUpCard>[0]["task"];
}

/**
 * Follow-up que o próprio Atendente IA executa: carrega as três ações
 * (executar agora, desligar a execução automática, pedir para a IA executar).
 * O painel monta este bloco com `key` da tarefa, então os estados de espera e
 * a confirmação não vazam de uma tarefa para outra.
 */
export function TaskAiFollowUp({ taskId, followUp, task }: TaskAiFollowUpProps) {
  const navigate = useNavigate();
  const runNow = useMutation(api.attendantFollowUp.runNow);
  const cancelAuto = useMutation(api.attendantFollowUp.cancelAuto);
  const adoptTask = useMutation(api.attendantFollowUp.adoptTask);
  const [runBusy, setRunBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [adoptBusy, setAdoptBusy] = useState(false);

  // "Executar agora": pula a janela de silêncio (decisão de quem clicou), mas
  // passa pela MESMA cadeia de guardas do disparo automático. Pode recusar
  // (canal caído, teto do dia etc.) e `reason` já vem em PT-BR.
  const handleRunNow = async () => {
    if (!followUp) return;
    setRunBusy(true);
    try {
      const result = await runNow({ followUpId: followUp._id });
      if (result.ok) {
        toast.success("A IA está executando o follow-up agora");
      } else {
        toast.error(
          result.reason
            ? `A IA não conseguiu: ${humanizeFollowUpReason(result.reason, followUp.channelLabel)}`
            : "A IA não conseguiu executar agora."
        );
      }
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível pedir a execução agora."));
    } finally {
      setRunBusy(false);
    }
  };

  const handleCancelAuto = async () => {
    if (!followUp) return;
    setCancelBusy(true);
    try {
      await cancelAuto({ followUpId: followUp._id });
      toast.success("Execução automática desligada. A tarefa continua com você");
      setCancelConfirm(false);
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível desligar a execução automática."));
    } finally {
      setCancelBusy(false);
    }
  };

  const handleAdopt = async () => {
    setAdoptBusy(true);
    try {
      const result = await adoptTask({ taskId });
      if (result.ok) {
        toast.success("A IA vai executar esta tarefa no vencimento");
      } else {
        toast.error(result.reason);
      }
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível pedir para a IA executar."));
    } finally {
      setAdoptBusy(false);
    }
  };

  return (
    <FollowUpCard
      followUp={followUp}
      task={task}
      onOpenConversation={(conversationId) => navigate(`${TAB_ROUTES.inbox}?conversation=${conversationId}`)}
      runBusy={runBusy}
      cancelBusy={cancelBusy}
      cancelConfirm={cancelConfirm}
      onRunNow={() => void handleRunNow()}
      onCancelAutoClick={() => setCancelConfirm(true)}
      onCancelAutoConfirm={() => void handleCancelAuto()}
      onCancelAutoAbort={() => setCancelConfirm(false)}
      adoptBusy={adoptBusy}
      onAdopt={() => void handleAdopt()}
    />
  );
}

