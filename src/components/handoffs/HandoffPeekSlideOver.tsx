import { useLayoutEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { ArrowLeftRight, MessageSquareOff, Sparkles } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { SlideOver } from "@/components/ui/SlideOver";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import { getAiDraft, AiInstructionPopover } from "@/components/inbox/AiDraftCard";
import type { InboxMessage } from "@/components/inbox/types";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";

// Últimas mensagens exibidas no peek — contexto suficiente para decidir sem
// carregar a conversa inteira.
const THREAD_LIMIT = 30;

// `getHandoffs` retorna v.any(): descrevemos aqui só o que o peek consome.
export interface PeekHandoff {
  _id: string;
  reason: string;
  summary?: string | null;
  suggestedActions?: string[];
  createdAt: number;
  conversationId?: string | null;
  lead?: {
    title?: string;
    value?: number;
    temperature?: string;
    qualification?: {
      budget?: boolean;
      authority?: boolean;
      need?: boolean;
      timeline?: boolean;
      score?: number;
    } | null;
  } | null;
  contact?: { firstName?: string; lastName?: string; company?: string } | null;
}

interface HandoffPeekSlideOverProps {
  organizationId: Id<"organizations">;
  handoff: PeekHandoff;
  onClose: () => void;
  onAccept: (handoffId: string) => Promise<void>;
  onReject: (handoffId: string, instruction?: string) => Promise<void>;
  busy?: boolean;
}

const BANT_LABELS: { key: "budget" | "authority" | "need" | "timeline"; label: string }[] = [
  { key: "budget", label: "Orçamento" },
  { key: "authority", label: "Decisor" },
  { key: "need", label: "Necessidade" },
  { key: "timeline", label: "Prazo" },
];

const TEMPERATURE_LABELS: Record<string, string> = {
  hot: "Quente",
  warm: "Morno",
  cold: "Frio",
};

function temperatureVariant(temperature: string): "error" | "warning" | "info" {
  if (temperature === "hot") return "error";
  if (temperature === "warm") return "warning";
  return "info";
}

const currencyFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

/**
 * Espiar o repasse antes de decidir: contexto estruturado (motivo, resumo da
 * IA, ações sugeridas, sinais do lead) + as últimas mensagens em modo leitura.
 * Aceitar/rejeitar ficam no rodapé fixo.
 */
export function HandoffPeekSlideOver({
  organizationId,
  handoff,
  onClose,
  onAccept,
  onReject,
  busy = false,
}: HandoffPeekSlideOverProps) {
  const conversationId = handoff.conversationId ?? null;

  const messages = useQuery(
    api.conversations.getMessages,
    conversationId ? { conversationId: conversationId as Id<"conversations"> } : "skip"
  ) as InboxMessage[] | undefined;

  const conversation = useQuery(
    api.conversations.getConversationById,
    conversationId ? { conversationId: conversationId as Id<"conversations"> } : "skip"
  ) as { channel?: string } | null | undefined;

  const threadRef = useRef<HTMLDivElement>(null);

  // Terceira saída além de aceitar/rejeitar: instruir a IA e revisar o
  // rascunho depois, sem tomar a conversa para si agora.
  const requestAiDraft = useMutation(api.attendant.requestAiDraft);
  const [instructOpen, setInstructOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [instructing, setInstructing] = useState(false);
  // Popover do "Devolver à IA" (rejeitar respondendo o que a IA precisava).
  const [returnOpen, setReturnOpen] = useState(false);

  const handleInstruct = async () => {
    const text = instruction.trim();
    if (!conversationId || !text) return;
    setInstructing(true);
    try {
      await requestAiDraft({
        conversationId: conversationId as Id<"conversations">,
        instruction: text,
      });
      setInstruction("");
      setInstructOpen(false);
      toast.success("Instrução enviada — a IA vai propor uma resposta para você revisar no inbox");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Falha ao enviar a instrução"));
    } finally {
      setInstructing(false);
    }
  };

  // Transcrever é leitura assistida (não fala com o cliente): fica disponível
  // no peek para dar sentido a um áudio antes de decidir sobre o repasse.
  const transcribe = useAction(api.transcription.transcribe);
  const [transcribingIds, setTranscribingIds] = useState<Set<string>>(() => new Set());

  const handleTranscribe = async (message: InboxMessage) => {
    setTranscribingIds((prev) => new Set(prev).add(message._id));
    try {
      const result = await transcribe({
        organizationId,
        messageId: message._id as Id<"messages">,
      });
      if (result.status === "failed") toast.error("Falha na transcrição");
    } catch {
      toast.error("Falha na transcrição");
    } finally {
      setTranscribingIds((prev) => {
        const next = new Set(prev);
        next.delete(message._id);
        return next;
      });
    }
  };

  // A leitura começa pela mensagem mais recente, como no inbox.
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (!el || !messages) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const contactName = `${handoff.contact?.firstName ?? ""} ${handoff.contact?.lastName ?? ""}`.trim();
  const qualification = handoff.lead?.qualification ?? null;
  const temperature = handoff.lead?.temperature;
  const value = handoff.lead?.value ?? 0;
  const suggestedActions = handoff.suggestedActions ?? [];
  const recentMessages = (messages ?? []).slice(-THREAD_LIMIT);

  const requestedAt = new Date(handoff.createdAt).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <SlideOver
      open
      onClose={onClose}
      title={`Repasse — ${handoff.lead?.title ?? "Lead"}`}
      titleIcon={<ArrowLeftRight size={18} className="text-semantic-warning shrink-0" />}
      className="md:w-[540px]"
      bodyClassName="flex-1 min-h-0 flex flex-col overflow-hidden"
    >
      {/* Contexto estruturado — fixo no topo, o thread rola abaixo dele */}
      <div className="shrink-0 border-b border-border bg-surface-raised px-4 py-3 md:px-5 space-y-3 max-h-[45%] overflow-y-auto">
        {contactName && (
          <p className="text-sm text-text-secondary truncate">
            {contactName}
            {handoff.contact?.company && ` • ${handoff.contact.company}`}
          </p>
        )}

        <div className="rounded-card border border-semantic-warning/40 bg-semantic-warning/5 px-3 py-2.5">
          <p className="text-xs font-medium text-semantic-warning mb-1">Motivo do repasse</p>
          <p className="text-sm text-text-primary">{handoff.reason}</p>
        </div>

        {handoff.summary && (
          <div>
            <h3 className="flex items-center gap-1.5 text-xs font-medium text-text-muted mb-1">
              <Sparkles size={12} className="text-purple-400" />
              Resumo da IA
            </h3>
            <p className="text-sm text-text-secondary whitespace-pre-wrap break-words">
              {handoff.summary}
            </p>
          </div>
        )}

        {suggestedActions.length > 0 && (
          <div>
            <h3 className="text-xs font-medium text-text-muted mb-1">Ações sugeridas</h3>
            <ul className="space-y-1">
              {suggestedActions.map((action, index) => (
                <li key={index} className="flex items-start gap-2 text-sm text-text-secondary">
                  <span className="text-text-muted mt-0.5">•</span>
                  <span className="flex-1">{action}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          {BANT_LABELS.map(({ key, label }) => {
            const on = qualification?.[key] === true;
            return (
              <span
                key={key}
                className={cn(
                  "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium border",
                  on
                    ? "border-semantic-success/40 bg-semantic-success/10 text-semantic-success"
                    : "border-border text-text-muted"
                )}
              >
                {label}
              </span>
            );
          })}
          {typeof qualification?.score === "number" && (
            <span className="inline-flex items-center rounded-full bg-surface-overlay px-2 py-0.5 text-[11px] font-medium text-text-secondary tabular-nums">
              {qualification.score}/4
            </span>
          )}
          {temperature && (
            <Badge variant={temperatureVariant(temperature)}>
              {TEMPERATURE_LABELS[temperature] ?? temperature}
            </Badge>
          )}
          {value > 0 && (
            <span className="inline-flex items-center rounded-full bg-surface-overlay px-2 py-0.5 text-[11px] font-medium text-text-primary tabular-nums">
              {currencyFormatter.format(value)}
            </span>
          )}
        </div>

        <p className="text-xs text-text-muted tabular-nums">Solicitado em {requestedAt}</p>
      </div>

      {/* Thread em modo leitura — sem responder, reagir ou encaminhar daqui */}
      <div ref={threadRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 md:px-5">
        {!conversationId ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <MessageSquareOff size={22} className="text-text-muted" />
            <p className="text-sm text-text-secondary">Sem conversa vinculada</p>
            <p className="text-xs text-text-muted">
              Este repasse não tem histórico de mensagens para exibir.
            </p>
          </div>
        ) : messages === undefined ? (
          <div className="flex justify-center py-10">
            <Spinner size="md" />
          </div>
        ) : recentMessages.length === 0 ? (
          <p className="text-center text-sm text-text-muted py-10">Nenhuma mensagem nesta conversa</p>
        ) : (
          <div className="flex flex-col gap-4">
            {messages.length > THREAD_LIMIT && (
              <p className="text-center text-xs text-text-muted">
                Exibindo as últimas {THREAD_LIMIT} mensagens
              </p>
            )}
            {recentMessages.map((message) => {
              const draft = getAiDraft(message);
              if (draft) {
                // Peek é só leitura: o rascunho aparece como aviso, a revisão
                // acontece no inbox. Rascunho já resolvido (enviado, descartado
                // ou substituído por uma nova versão) fica em tom neutro.
                const pendingDraft = draft.status === "pending";
                const draftLabel = pendingDraft
                  ? "Rascunho da IA aguardando revisão"
                  : draft.status === "revised"
                    ? "Rascunho substituído por nova versão"
                    : draft.status === "discarded"
                      ? "Rascunho da IA descartado"
                      : "Sugestão da IA enviada";
                return (
                  <div
                    key={message._id}
                    className={cn(
                      "self-end w-full max-w-md rounded-xl border px-3 py-2",
                      pendingDraft
                        ? "border-purple-500/40 bg-purple-500/5"
                        : "border-border bg-surface-raised"
                    )}
                  >
                    <p
                      className={cn(
                        "flex items-center gap-1.5 text-xs font-medium mb-1",
                        pendingDraft ? "text-purple-300" : "text-text-muted"
                      )}
                    >
                      <Sparkles size={12} />
                      {draftLabel}
                    </p>
                    <p className="text-xs text-text-secondary line-clamp-3 break-words">
                      {message.content}
                    </p>
                  </div>
                );
              }
              return (
                <MessageBubble
                  key={message._id}
                  message={message}
                  channelIsWhatsapp={conversation?.channel === "whatsapp"}
                  canInteract={false}
                  currentMemberId={null}
                  contactName={contactName}
                  transcribing={transcribingIds.has(message._id)}
                  highlighted={false}
                  onReply={() => {}}
                  onReact={() => {}}
                  onForward={() => {}}
                  onTranscribe={(m) => void handleTranscribe(m)}
                  onJumpToMessage={() => {}}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border bg-surface-raised p-3 space-y-2">
        {conversationId && (
          <div>
            {instructOpen ? (
              <div className="space-y-2">
                <textarea
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  autoFocus
                  placeholder='Instrua a IA: "explique o prazo de implantação e ofereça uma call amanhã"'
                  aria-label="Instrução para a IA"
                  className="w-full resize-y px-3 py-2 rounded-lg bg-surface-sunken border border-border-strong text-text-primary placeholder:text-text-muted text-base md:text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
                />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={instructing}
                    onClick={() => {
                      setInstructOpen(false);
                      setInstruction("");
                    }}
                  >
                    Cancelar
                  </Button>
                  <Button
                    size="sm"
                    disabled={instructing || !instruction.trim()}
                    onClick={() => void handleInstruct()}
                  >
                    Enviar instrução
                  </Button>
                </div>
                <p className="text-xs text-text-muted">
                  O repasse continua pendente — revise o rascunho na conversa.
                </p>
              </div>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setInstructOpen(true)}>
                <Sparkles size={14} className="mr-1.5" />
                Instruir a IA em vez de assumir
              </Button>
            )}
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setReturnOpen((v) => !v)}
              className="w-full whitespace-nowrap text-semantic-error border-semantic-error/30 hover:bg-semantic-error/10"
            >
              Devolver à IA
            </Button>
            {returnOpen && (
              <AiInstructionPopover
                title="Devolver à IA — responda o que ela precisa (opcional)"
                placeholder='Ex.: "o Pix é financeiro@empresa.com e o valor é R$ 150 — pode passar ao cliente". Vazio = só rejeitar.'
                submitLabel="Devolver"
                direction="up"
                onSubmit={(instruction) => {
                  setReturnOpen(false);
                  void onReject(handoff._id, instruction);
                }}
                onClose={() => setReturnOpen(false)}
              />
            )}
          </div>
          <Button
            disabled={busy}
            onClick={() => void onAccept(handoff._id)}
            className="flex-1 whitespace-nowrap"
          >
            Aceitar e abrir conversa
          </Button>
        </div>
      </div>
    </SlideOver>
  );
}
