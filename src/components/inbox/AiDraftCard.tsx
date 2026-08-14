import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Sparkles, Send, Pencil, Trash2, Check, X, RefreshCw } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import { InboxMessage } from "./types";

// v4.2: proposedActions estruturadas (aprováveis, uma a uma). Rascunhos
// antigos ainda guardam string[] — sem checkbox, apenas informativo.
type ProposedActionStructured = { name: string; argsJson: string; label: string };
type ProposedAction = ProposedActionStructured | string;

type AppliedAction = {
  index: number;
  label: string;
  ok: boolean;
  error?: string;
};

// "revised" = o rascunho foi substituído por uma nova versão pedida pelo time
// (loop de coaching); os dois ficam encadeados por previous/nextDraftId.
type AiDraftMeta = {
  status: "pending" | "sent" | "sent_edited" | "discarded" | "revised";
  proposedActions?: ProposedAction[];
  appliedActions?: AppliedAction[];
  confidence?: number;
  instruction?: string;
  previousDraftId?: string;
  nextDraftId?: string;
};

// Atalhos de coaching — clicar preenche o campo, o humano ainda pode editar
// antes de mandar reescrever.
const INSTRUCTION_CHIPS: { label: string; instruction: string }[] = [
  { label: "Mais formal", instruction: "Reescreva com um tom mais formal." },
  { label: "Mais curto", instruction: "Deixe a resposta mais curta e direta." },
  { label: "Mais caloroso", instruction: "Deixe o tom mais caloroso e próximo do cliente." },
  { label: "Oferecer alternativa", instruction: "Ofereça uma alternativa ao cliente." },
];

const MAX_INSTRUCTION_CHARS = 2000;

export function getAiDraft(message: InboxMessage): AiDraftMeta | null {
  const draft = message.metadata?.aiDraft as AiDraftMeta | undefined;
  return draft && typeof draft.status === "string" ? draft : null;
}

function isStructuredAction(action: ProposedAction): action is ProposedActionStructured {
  return typeof action === "object" && action !== null && typeof action.name === "string";
}

// Rótulo PT-BR amigável para um movimento proposto legado ("moveThisLead({...})").
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
 * v4.2: ações propostas estruturadas viram checkboxes aprováveis (marcadas por
 * padrão) e são executadas junto do envio via `actionIndexes`.
 */
export function AiDraftCard({ message }: { message: InboxMessage }) {
  const draft = getAiDraft(message)!;
  const acceptDraft = useMutation(api.attendant.acceptAiDraft);
  const discardDraft = useMutation(api.attendant.discardAiDraft);
  const requestDraft = useMutation(api.attendant.requestAiDraft);

  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState(message.content);
  const [busy, setBusy] = useState(false);
  const [instruction, setInstruction] = useState("");
  // Enquanto a IA reescreve, este card fica congelado — quando o novo rascunho
  // chega, este vira "revised" pela reatividade e colapsa.
  const [regenerating, setRegenerating] = useState(false);

  // Se o turno da IA falhar, nada chega por reatividade para desbloquear o
  // card — libera as ações depois de um tempo em vez de prender o humano.
  useEffect(() => {
    if (!regenerating) return;
    const timer = window.setTimeout(() => setRegenerating(false), 90_000);
    return () => window.clearTimeout(timer);
  }, [regenerating]);

  const proposedActions = draft.proposedActions ?? [];
  const hasStructuredActions = proposedActions.some(isStructuredAction);
  // Marcadas por padrão — o humano desmarca o que não quer executar.
  const [selectedActions, setSelectedActions] = useState<Set<number>>(
    () => new Set(proposedActions.map((a, i) => (isStructuredAction(a) ? i : -1)).filter((i) => i >= 0))
  );
  const toggleAction = (i: number) => {
    setSelectedActions((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const resolved = draft.status !== "pending";

  const handleSend = async (text?: string) => {
    setBusy(true);
    try {
      const actionIndexes = hasStructuredActions ? Array.from(selectedActions) : undefined;
      await acceptDraft({
        draftMessageId: message._id as Id<"messages">,
        ...(text !== undefined ? { editedText: text } : {}),
        ...(actionIndexes ? { actionIndexes } : {}),
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

  // Coaching: o humano instrui e a IA propõe outra versão deste rascunho.
  const handleRegenerate = async () => {
    const text = instruction.trim();
    setRegenerating(true);
    try {
      await requestDraft({
        conversationId: message.conversationId as Id<"conversations">,
        ...(text ? { instruction: text } : {}),
        sourceDraftId: message._id as Id<"messages">,
      });
      setInstruction("");
      toast.success("Instrução enviada — a IA está reescrevendo…");
    } catch (e) {
      setRegenerating(false);
      toast.error(mutationErrorMessage(e, "Falha ao pedir uma nova versão"));
    }
  };

  if (resolved) {
    const resolvedLabel =
      draft.status === "discarded"
        ? "Sugestão da IA descartada"
        : draft.status === "revised"
          ? "Substituído por nova versão (instrução do time)"
          : draft.status === "sent_edited"
            ? "Sugestão da IA enviada (editada)"
            : "Sugestão da IA enviada";
    return (
      <div className="flex justify-end">
        <div className="flex flex-col items-end gap-1.5 max-w-md">
          <span className="inline-flex items-center gap-1.5 text-xs text-text-muted bg-surface-overlay px-3 py-1.5 rounded-full">
            {draft.status === "revised" ? <RefreshCw size={12} /> : <Sparkles size={12} />}
            {resolvedLabel}
          </span>
          {draft.appliedActions && draft.appliedActions.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {draft.appliedActions.map((a) => (
                <span
                  key={a.index}
                  title={a.error}
                  className={cn(
                    "inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full",
                    a.ok
                      ? "bg-semantic-success/10 text-semantic-success"
                      : "bg-semantic-error/10 text-semantic-error"
                  )}
                >
                  {a.ok ? <Check size={11} /> : <X size={11} />}
                  {a.label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-end">
      <div className="w-full max-w-md rounded-xl border border-purple-500/40 bg-purple-500/5 overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
          <Sparkles size={14} className="text-purple-400 shrink-0" />
          <span className="flex-1 min-w-0 text-xs font-medium text-purple-300">
            Sugestão do atendente IA — aguardando sua revisão
          </span>
          {typeof draft.confidence === "number" && (
            <span
              className="ml-auto shrink-0 rounded-full bg-purple-500/15 px-2 py-0.5 text-[11px] font-medium text-purple-300 tabular-nums"
              title="Confiança que a IA declarou nesta resposta"
            >
              confiança {Math.round(draft.confidence * 100)}%
            </span>
          )}
        </div>

        <div className="px-4 py-3">
          {draft.instruction && (
            <p className="mb-1.5 text-xs italic text-text-muted truncate" title={draft.instruction}>
              Instrução aplicada: "{draft.instruction}"
            </p>
          )}
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

          {proposedActions.length > 0 && (
            <div className="mt-3 pt-3 border-t border-border">
              <p className="text-xs text-text-muted mb-1.5">
                {hasStructuredActions ? "Ações que a IA faria — desmarque o que não quer executar:" : "Movimentos que a IA faria:"}
              </p>
              <ul className="space-y-1.5">
                {proposedActions.map((action, i) =>
                  isStructuredAction(action) ? (
                    <li key={i}>
                      <Checkbox
                        checked={selectedActions.has(i)}
                        onChange={() => toggleAction(i)}
                        label={<span className="text-xs text-text-secondary">{action.label}</span>}
                      />
                    </li>
                  ) : (
                    <li key={i} className="text-xs text-text-secondary flex items-center gap-1.5">
                      <span className="h-1 w-1 rounded-full bg-purple-400 shrink-0" />
                      {actionLabel(action)}
                    </li>
                  )
                )}
              </ul>
            </div>
          )}
        </div>

        {/* Coaching: instruir a IA e receber outra versão deste rascunho */}
        <div className="border-t border-purple-500/20 px-4 py-3">
          {regenerating ? (
            <p className="flex items-center gap-2 text-xs text-text-secondary">
              <Spinner size="sm" />
              IA reescrevendo o rascunho…
            </p>
          ) : (
            <>
              <p className="text-xs font-medium text-text-secondary mb-2">Instruir a IA</p>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {INSTRUCTION_CHIPS.map((chip) => (
                  <button
                    key={chip.label}
                    type="button"
                    onClick={() => setInstruction(chip.instruction)}
                    className="rounded-full border border-border-strong px-2.5 py-1 text-[11px] font-medium text-text-secondary hover:border-purple-500/60 hover:text-purple-300 transition-colors"
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={instruction}
                  maxLength={MAX_INSTRUCTION_CHARS}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleRegenerate();
                    }
                  }}
                  placeholder={'Instrua a IA: "ofereça 10% de desconto e pergunte o prazo"'}
                  aria-label="Instrução para a IA reescrever o rascunho"
                  className="min-w-0 flex-1 h-10 px-3 rounded-lg bg-surface-raised border border-border-strong text-text-primary placeholder:text-text-muted text-base md:text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void handleRegenerate()}
                  className="shrink-0"
                >
                  <RefreshCw size={14} className="mr-1.5" />
                  Regenerar
                </Button>
              </div>
            </>
          )}
        </div>

        <div
          className={cn(
            "flex gap-2 px-4 pb-3",
            (busy || regenerating) && "opacity-60 pointer-events-none"
          )}
        >
          {editing ? (
            <>
              <Button
                disabled={busy || regenerating}
                onClick={() => void handleSend(editedText)}
                className="flex-1"
              >
                <Check size={14} className="mr-1.5" />
                Enviar editado
              </Button>
              <Button
                variant="secondary"
                disabled={busy || regenerating}
                aria-label="Cancelar edição"
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
              <Button
                disabled={busy || regenerating}
                onClick={() => void handleSend()}
                className="flex-1"
              >
                <Send size={14} className="mr-1.5" />
                Enviar
              </Button>
              <Button
                variant="secondary"
                disabled={busy || regenerating}
                onClick={() => setEditing(true)}
              >
                <Pencil size={14} className="mr-1.5" />
                Editar
              </Button>
              <Button
                variant="ghost"
                disabled={busy || regenerating}
                aria-label="Descartar sugestão"
                onClick={() => void handleDiscard()}
              >
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
 * Painel ancorado com uma instrução em texto livre para a IA. Usado por
 * "Devolver para IA" e "Pedir sugestão à IA" — no mobile abre alinhado à
 * esquerda do gatilho para não sair da tela.
 */
function AiInstructionPopover({
  title,
  placeholder,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  placeholder: string;
  submitLabel: string;
  onSubmit: (instruction?: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const trimmed = text.trim();

  return (
    <div className="absolute top-full left-0 md:left-auto md:right-0 mt-2 z-40 w-[calc(100vw-2rem)] max-w-xs p-3 bg-surface-overlay border border-border rounded-xl shadow-elevated space-y-2.5">
      <p className="text-xs font-medium text-text-primary">{title}</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        rows={3}
        maxLength={MAX_INSTRUCTION_CHARS}
        autoFocus
        placeholder={placeholder}
        aria-label={title}
        className="w-full resize-y px-3 py-2 rounded-lg bg-surface-sunken border border-border-strong text-text-primary placeholder:text-text-muted text-base md:text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
      />
      <div className="flex justify-end gap-2">
        {/* type="button" obrigatório: o popover pode abrir dentro de um form */}
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancelar
        </Button>
        <Button type="button" size="sm" onClick={() => onSubmit(trimmed || undefined)}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * Devolve a conversa à IA (despausa, reatribui o lead ao atendente e cancela
 * repasse pendente), opcionalmente já com uma instrução de contexto.
 * `variant="button"` para barras de ação, `"link"` para o header da conversa.
 */
export function ReturnToAiButton({
  conversationId,
  variant = "link",
}: {
  conversationId: Id<"conversations">;
  variant?: "link" | "button";
}) {
  const returnToAi = useMutation(api.attendant.returnToAi);
  const [open, setOpen] = useState(false);

  const submit = (instruction?: string) => {
    setOpen(false);
    toast.promise(returnToAi({ conversationId, ...(instruction ? { instruction } : {}) }), {
      loading: "Devolvendo…",
      success: "Conversa devolvida à IA",
      error: (e) => mutationErrorMessage(e, "Falha ao devolver para a IA"),
    });
  };

  return (
    <div className="relative">
      {variant === "button" ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
          <Sparkles size={14} className="mr-1.5" />
          Devolver para IA
        </Button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs text-brand-500 hover:text-brand-400 font-medium"
        >
          Devolver para IA
        </button>
      )}
      {open && (
        <AiInstructionPopover
          title="Devolver a conversa para a IA"
          placeholder="Instrução para a IA (opcional): ex. faça follow-up amanhã oferecendo o plano anual"
          submitLabel="Devolver"
          onSubmit={submit}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Controles de IA no header da conversa: pill de status + assumir a conversa,
 * devolver para a IA (quando pausada) ou pedir uma sugestão (quando ativa e
 * sem rascunho na fila). Só renderiza quando a org tem IA ativa (gate no
 * chamador).
 */
export function AiConversationControls({
  conversationId,
  aiPausedUntil,
  hasPendingDraft = false,
}: {
  conversationId: Id<"conversations">;
  aiPausedUntil?: number;
  hasPendingDraft?: boolean;
}) {
  const assumeConversation = useMutation(api.conversations.assumeConversation);
  const requestDraft = useMutation(api.attendant.requestAiDraft);
  const paused = aiPausedUntil !== undefined && aiPausedUntil > Date.now();
  const [askOpen, setAskOpen] = useState(false);

  const requestSuggestion = (instruction?: string) => {
    setAskOpen(false);
    toast.promise(requestDraft({ conversationId, ...(instruction ? { instruction } : {}) }), {
      loading: "Pedindo à IA…",
      success: "Pedido enviado — a IA vai propor uma resposta",
      error: (e) => mutationErrorMessage(e, "Falha ao pedir sugestão à IA"),
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
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
        <ReturnToAiButton conversationId={conversationId} />
      ) : (
        <>
          <button
            type="button"
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
          {!hasPendingDraft && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setAskOpen((v) => !v)}
                className="inline-flex items-center gap-1 text-xs text-brand-500 hover:text-brand-400 font-medium"
              >
                <Sparkles size={12} />
                Pedir sugestão à IA
              </button>
              {askOpen && (
                <AiInstructionPopover
                  title="Pedir uma sugestão de resposta"
                  placeholder="Instrução para a IA (opcional): ex. responda a última dúvida e proponha uma call"
                  submitLabel="Pedir"
                  onSubmit={requestSuggestion}
                  onClose={() => setAskOpen(false)}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
