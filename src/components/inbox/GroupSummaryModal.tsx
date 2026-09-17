import { useState } from "react";
import { useAction } from "convex/react";
import { Sparkles, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";

/**
 * "Resumo por IA" de um grupo (F4, §9.2).
 *
 * O texto vem de UMA chamada de LLM e fica gravado em `groupChats.summary`:
 * quem abrir depois lê o mesmo resumo sem pagar outra inferência. "Atualizar"
 * é explícito justamente por isso.
 *
 * O resumo é dado de terceiros (as mensagens dos membros) atravessado por um
 * modelo — renderizado como TEXTO puro, nunca como HTML/markdown.
 */

interface GroupSummaryModalProps {
  open: boolean;
  groupChatId: Id<"groupChats">;
  groupSubject: string;
  /** Resumo já salvo, para a tela abrir com conteúdo em vez de vazia. */
  initial?: { text: string; at: number; hours?: number } | null;
  onClose: () => void;
}

const WINDOWS = [
  { hours: 24 as const, label: "24 horas" },
  { hours: 168 as const, label: "7 dias" },
];

export function GroupSummaryModal({
  open,
  groupChatId,
  groupSubject,
  initial,
  onClose,
}: GroupSummaryModalProps) {
  const summarize = useAction(api.groupChats.summarizeGroup);
  const [hours, setHours] = useState<24 | 168>((initial?.hours as 24 | 168) ?? 24);
  const [text, setText] = useState<string | null>(initial?.text ?? null);
  const [at, setAt] = useState<number | null>(initial?.at ?? null);
  const [loading, setLoading] = useState(false);

  if (!open) return null;

  const run = async (window: 24 | 168) => {
    setLoading(true);
    try {
      const result = await summarize({ groupChatId, hours: window });
      if (result.error) {
        toast.error(
          result.error === "sem_mensagens_no_periodo"
            ? "Nenhuma mensagem nesse período"
            : result.error
        );
        return;
      }
      setText(result.text);
      setAt(result.at);
      setHours(window);
    } catch (e) {
      toast.error(e instanceof Error ? e.message.split("\n")[0] : "Falha ao gerar o resumo");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4">
      <div className="w-full sm:max-w-lg max-h-[85vh] flex flex-col bg-surface-raised border border-border rounded-t-2xl sm:rounded-2xl shadow-elevated">
        <div className="flex items-start gap-3 p-4 border-b border-border">
          <div className="h-9 w-9 shrink-0 rounded-full bg-brand-500/10 flex items-center justify-center">
            <Sparkles size={17} className="text-brand-500" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-text-primary truncate">Resumo por IA</h3>
            <p className="text-xs text-text-muted truncate">{groupSubject}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-overlay"
            aria-label="Fechar"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex items-center gap-2 px-4 pt-3">
          {WINDOWS.map((w) => (
            <button
              key={w.hours}
              type="button"
              disabled={loading}
              onClick={() => void run(w.hours)}
              className={cn(
                "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                hours === w.hours
                  ? "bg-brand-500/15 text-brand-500"
                  : "text-text-muted hover:text-text-primary hover:bg-surface-overlay"
              )}
            >
              {w.label}
            </button>
          ))}
          <button
            type="button"
            disabled={loading}
            onClick={() => void run(hours)}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-text-muted hover:text-text-primary hover:bg-surface-overlay disabled:opacity-50"
          >
            <RefreshCw size={13} className={cn(loading && "animate-spin")} />
            {text ? "Atualizar" : "Gerar"}
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-text-muted py-6 justify-center">
              <Spinner />
              Lendo a conversa…
            </div>
          ) : text ? (
            <>
              <p className="whitespace-pre-wrap text-sm text-text-primary leading-relaxed">{text}</p>
              {at && (
                <p className="mt-3 text-[11px] text-text-muted">
                  Gerado em {new Date(at).toLocaleString("pt-BR")} · últimas{" "}
                  {hours === 168 ? "168 h" : "24 h"}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-text-muted py-6 text-center">
              Escolha o período e gere o resumo do que aconteceu na sala.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
