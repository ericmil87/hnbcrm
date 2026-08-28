import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { useCopilotStream, toolLabel } from "@/hooks/useCopilotStream";
import { SlideOver } from "@/components/ui/SlideOver";
import { Markdown, CopyButton } from "@/components/ui/Markdown";
import { Spinner } from "@/components/ui/Spinner";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Sparkles, Plus, Send, AlertTriangle } from "lucide-react";

const SUGGESTIONS = [
  "Como está meu funil?",
  "Quais leads quentes estão sem resposta?",
  "Resuma as métricas do mês",
];

interface CopilotPanelProps {
  organizationId: Id<"organizations">;
  open: boolean;
  onClose: () => void;
}

export function CopilotPanel({ organizationId, open, onClose }: CopilotPanelProps) {
  const {
    streamingText,
    activeTools,
    isStreaming,
    error,
    threadId,
    sendMessage,
    startNewThread,
  } = useCopilotStream(organizationId);

  const messages = useQuery(
    api.copilot.getThreadMessages,
    threadId ? { threadId } : "skip"
  );

  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll para o fim em novas mensagens ou deltas de streaming.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, activeTools]);

  // Textarea auto-expansível (até um teto, depois rola internamente).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const handleSend = (text?: string) => {
    const value = (text ?? input).trim();
    if (!value || isStreaming) return;
    setInput("");
    void sendMessage(value);
  };

  const handleNewThread = () => {
    setInput("");
    startNewThread();
  };

  const hasConversation =
    threadId !== null || (messages?.length ?? 0) > 0 || streamingText.length > 0;

  return (
    <SlideOver
      open={open}
      onClose={onClose}
      title="Copiloto IA"
      titleIcon={<Sparkles size={18} className="text-brand-500 shrink-0" aria-hidden="true" />}
      headerActions={
        <button
          onClick={handleNewThread}
          disabled={isStreaming}
          className="h-11 w-11 shrink-0 flex items-center justify-center rounded-full text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors disabled:opacity-50 disabled:pointer-events-none"
          aria-label="Nova conversa"
          title="Nova conversa"
        >
          <Plus size={18} />
        </button>
      }
      className="md:w-[520px] lg:w-[600px] xl:w-[680px]"
      bodyClassName="flex-1 min-h-0 flex flex-col overflow-hidden"
    >
      {/* Mensagens */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 md:px-6 space-y-4">
        {!hasConversation ? (
          <EmptyState onPickSuggestion={(s) => handleSend(s)} />
        ) : (
          <>
            {messages === undefined ? (
              <div className="flex justify-center py-8">
                <Spinner size="lg" />
              </div>
            ) : (
              messages
                .filter((m) => m.role === "user" || m.role === "assistant")
                .map((m) => <MessageBubble key={m._id} role={m.role as "user" | "assistant"} content={m.content} toolCalls={m.toolCalls} />)
            )}

            {isStreaming && (
              <StreamingBubble text={streamingText} tools={activeTools} />
            )}

            {/* Erro do último turno fica visível (não só o toast fugaz) */}
            {error && !isStreaming && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm bg-semantic-error/10 text-semantic-error border border-semantic-error/30">
                  {error} — tente enviar de novo.
                </div>
              </div>
            )}
          </>
        )}

        {/* Confirmações destrutivas pendentes (two-phase): só executam aqui */}
        <PendingActionsCard organizationId={organizationId} />
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-border p-3 md:p-4">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Pergunte algo ao copiloto..."
            rows={1}
            disabled={isStreaming}
            className="flex-1 resize-none px-3 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-lg text-base md:text-sm placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 disabled:opacity-60 max-h-40"
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || isStreaming}
            className="h-11 w-11 shrink-0 flex items-center justify-center rounded-full bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 disabled:opacity-50 disabled:pointer-events-none transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
            aria-label="Enviar mensagem"
          >
            {isStreaming ? <Spinner size="sm" className="border-white border-t-transparent" /> : <Send size={18} />}
          </button>
        </div>
      </div>
    </SlideOver>
  );
}

function PendingActionsCard({ organizationId }: { organizationId: Id<"organizations"> }) {
  const pending = useQuery(api.copilot.listPendingActions, { organizationId });
  const confirm = useMutation(api.copilot.confirmPendingAction);
  const cancel = useMutation(api.copilot.cancelPendingAction);

  if (!pending || pending.length === 0) return null;

  return (
    <div className="space-y-2">
      {pending.map((action) => (
        <div
          key={action._id}
          className="rounded-xl border border-semantic-error/40 bg-semantic-error/5 p-4"
        >
          <div className="flex items-start gap-2 mb-3">
            <AlertTriangle size={18} className="text-semantic-error shrink-0 mt-0.5" />
            <p className="text-sm text-text-primary">{action.preview}</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="danger"
              onClick={() =>
                toast.promise(confirm({ pendingActionId: action._id }), {
                  loading: "Executando...",
                  success: "Ação executada",
                  error: (e) =>
                    e instanceof Error ? e.message : "Falha ao executar a ação",
                })
              }
              className="flex-1"
            >
              Confirmar
            </Button>
            <Button
              variant="secondary"
              onClick={() => void cancel({ pendingActionId: action._id })}
              className="flex-1"
            >
              Cancelar
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ onPickSuggestion }: { onPickSuggestion: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-4 py-8">
      <div className="h-12 w-12 rounded-full bg-brand-500/10 flex items-center justify-center mb-4">
        <Sparkles size={24} className="text-brand-500" />
      </div>
      <h3 className="text-base font-semibold text-text-primary mb-1">
        Olá! Eu sou o Copiloto do HNBCRM
      </h3>
      <p className="text-sm text-text-secondary mb-6 max-w-xs">
        Posso consultar seu funil, leads, contatos e métricas para te ajudar. Experimente uma sugestão:
      </p>
      <div className="w-full max-w-xs space-y-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onPickSuggestion(s)}
            className="w-full min-h-[44px] px-4 py-2.5 text-left text-sm text-text-primary bg-surface-overlay border border-border rounded-lg hover:border-brand-500 hover:bg-brand-500/10 transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function ToolChips({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mb-2">
      {names.map((name, i) => (
        <Badge key={`${name}-${i}`} variant="brand">
          {toolLabel(name)}
        </Badge>
      ))}
    </div>
  );
}

function MessageBubble({
  role,
  content,
  toolCalls,
}: {
  role: "user" | "assistant";
  content: string;
  toolCalls?: { name: string }[];
}) {
  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 text-sm bg-brand-600 text-white whitespace-pre-wrap break-words">
          {content}
        </div>
      </div>
    );
  }

  // A resposta da IA ocupa a largura toda: tabela, lista e bloco de código
  // ficam ilegíveis espremidos em 85% de um painel estreito.
  return (
    <div className="group/msg rounded-2xl rounded-bl-md px-4 py-3 text-sm bg-surface-overlay text-text-primary border border-border">
      <ToolChips names={(toolCalls ?? []).map((tc) => tc.name)} />
      <Markdown content={content} />
      {content.trim().length > 0 && (
        <div className="mt-2 -mb-1 flex justify-end opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
          <CopyButton text={content} label="Copiar resposta" />
        </div>
      )}
    </div>
  );
}

function StreamingBubble({ text, tools }: { text: string; tools: string[] }) {
  return (
    <div className="rounded-2xl rounded-bl-md px-4 py-3 text-sm bg-surface-overlay text-text-primary border border-border">
      {tools.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {tools.map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-1.5 rounded-full bg-brand-500/10 text-brand-400 px-2.5 py-0.5 text-xs font-medium"
            >
              <Spinner size="sm" className="h-3 w-3 border-[1.5px]" />
              {toolLabel(name)}…
            </span>
          ))}
        </div>
      )}
      {text ? (
        <>
          <Markdown content={text} />
          <span
            className="mt-1 inline-block h-3.5 w-1.5 animate-pulse-brand rounded-sm bg-brand-500 align-middle"
            aria-hidden="true"
          />
        </>
      ) : tools.length === 0 ? (
        <span className="inline-flex items-center gap-2 text-text-secondary">
          <Spinner size="sm" />
          Pensando...
        </span>
      ) : null}
    </div>
  );
}
