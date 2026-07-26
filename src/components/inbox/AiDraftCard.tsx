import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Sparkles, Send, Pencil, Trash2, Check, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { InboxMessage } from "./types";

type AiDraftMeta = {
  status: "pending" | "sent" | "sent_edited" | "discarded";
  proposedActions?: string[];
  confidence?: number;
};

export function getAiDraft(message: InboxMessage): AiDraftMeta | null {
  const draft = message.metadata?.aiDraft as AiDraftMeta | undefined;
  return draft && typeof draft.status === "string" ? draft : null;
}

// Rótulo PT-BR amigável para um movimento proposto ("moveThisLead({...})").
function actionLabel(raw: string): string {
  const name = raw.split("(")[0];
  const labels: Record<string, string> = {
    moveThisLead: "Mover o lead de estágio",
    scheduleFollowUp: "Agendar follow-up",
    qualifyThisLead: "Atualizar qualificação BANT",
    requestHandoff: "Repassar para humano",
  };
  const label = labels[name] ?? name;
  const argsMatch = raw.match(/\((.*)\)$/);
  if (argsMatch) {
    try {
      const args = JSON.parse(argsMatch[1]);
      if (typeof args.stageName === "string") return `${label}: "${args.stageName}"`;
      if (typeof args.title === "string") return `${label}: "${args.title}"`;
    } catch {
      // argumentos ilegíveis — mostra só o rótulo
    }
  }
  return label;
}

/**
 * Rascunho do atendente IA (modo sugestão) dentro da conversa: o humano revisa
 * e decide — Enviar / Editar e enviar / Descartar. Nada sai sem esse clique.
 */
export function AiDraftCard({ message }: { message: InboxMessage }) {
  const draft = getAiDraft(message)!;
  const acceptDraft = useMutation(api.attendant.acceptAiDraft);
  const discardDraft = useMutation(api.attendant.discardAiDraft);

  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState(message.content);
  const [busy, setBusy] = useState(false);

  const resolved = draft.status !== "pending";

  const handleSend = async (text?: string) => {
    setBusy(true);
    try {
      await acceptDraft({
        draftMessageId: message._id as Id<"messages">,
        ...(text !== undefined ? { editedText: text } : {}),
      });
      toast.success("Resposta enviada ao cliente");
      setEditing(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao enviar");
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async () => {
    setBusy(true);
    try {
      await discardDraft({ draftMessageId: message._id as Id<"messages"> });
      toast.success("Sugestão descartada");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao descartar");
    } finally {
      setBusy(false);
    }
  };

  if (resolved) {
    const resolvedLabel =
      draft.status === "discarded"
        ? "Sugestão da IA descartada"
        : draft.status === "sent_edited"
          ? "Sugestão da IA enviada (editada)"
          : "Sugestão da IA enviada";
    return (
      <div className="flex justify-end">
        <span className="inline-flex items-center gap-1.5 text-xs text-text-muted bg-surface-overlay px-3 py-1.5 rounded-full">
          <Sparkles size={12} />
          {resolvedLabel}
        </span>
      </div>
    );
  }

  return (
    <div className="flex justify-end">
      <div className="w-full max-w-md rounded-xl border border-purple-500/40 bg-purple-500/5 overflow-hidden">
        <div className="flex items-center gap-2 px-4 pt-3">
          <Sparkles size={14} className="text-purple-400 shrink-0" />
          <span className="text-xs font-medium text-purple-300">
            Sugestão do atendente IA — aguardando sua revisão
          </span>
        </div>

        <div className="px-4 py-3">
          {editing ? (
            <textarea
              value={editedText}
              onChange={(e) => setEditedText(e.target.value)}
              rows={4}
              className="w-full resize-y px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
            />
          ) : (
            <p className="text-sm text-text-primary whitespace-pre-wrap break-words">
              {message.content}
            </p>
          )}

          {draft.proposedActions && draft.proposedActions.length > 0 && (
            <div className="mt-3 pt-3 border-t border-border">
              <p className="text-xs text-text-muted mb-1.5">Movimentos que a IA faria:</p>
              <ul className="space-y-1">
                {draft.proposedActions.map((action, i) => (
                  <li key={i} className="text-xs text-text-secondary flex items-center gap-1.5">
                    <span className="h-1 w-1 rounded-full bg-purple-400 shrink-0" />
                    {actionLabel(action)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className={cn("flex gap-2 px-4 pb-3", busy && "opacity-60 pointer-events-none")}>
          {editing ? (
            <>
              <Button onClick={() => void handleSend(editedText)} className="flex-1">
                <Check size={14} className="mr-1.5" />
                Enviar editado
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(false);
                  setEditedText(message.content);
                }}
              >
                <X size={14} />
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => void handleSend()} className="flex-1">
                <Send size={14} className="mr-1.5" />
                Enviar
              </Button>
              <Button variant="secondary" onClick={() => setEditing(true)}>
                <Pencil size={14} className="mr-1.5" />
                Editar
              </Button>
              <Button variant="ghost" onClick={() => void handleDiscard()}>
                <Trash2 size={14} />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Controles de IA no header da conversa: pill de status + assumir/reativar.
 * Só renderiza quando a org tem IA ativa (gate no chamador).
 */
export function AiConversationControls({
  conversationId,
  aiPausedUntil,
}: {
  conversationId: Id<"conversations">;
  aiPausedUntil?: number;
}) {
  const assumeConversation = useMutation(api.conversations.assumeConversation);
  const setAiPaused = useMutation(api.conversations.setAiPaused);
  const paused = aiPausedUntil !== undefined && aiPausedUntil > Date.now();

  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
          paused
            ? "bg-surface-overlay text-text-muted"
            : "bg-purple-500/10 text-purple-400"
        )}
      >
        <Sparkles size={12} />
        {paused ? "IA pausada" : "IA ativa"}
      </span>
      {paused ? (
        <button
          onClick={() =>
            toast.promise(setAiPaused({ conversationId, paused: false }), {
              loading: "Reativando...",
              success: "IA reativada nesta conversa",
              error: "Falha ao reativar",
            })
          }
          className="text-xs text-brand-500 hover:text-brand-400 font-medium"
        >
          Reativar IA
        </button>
      ) : (
        <button
          onClick={() =>
            toast.promise(assumeConversation({ conversationId }), {
              loading: "Assumindo...",
              success: "Conversa assumida — IA pausada",
              error: "Falha ao assumir",
            })
          }
          className="text-xs text-brand-500 hover:text-brand-400 font-medium"
        >
          Assumir conversa
        </button>
      )}
    </div>
  );
}
