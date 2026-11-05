import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthToken } from "@convex-dev/auth/react";
import { toast } from "sonner";
import { Id } from "../../convex/_generated/dataModel";

/** Rótulos PT-BR amigáveis para os chips "consultando…" durante o streaming. */
const TOOL_LABELS: Record<string, string> = {
  getPipelineOverview: "consultando o funil",
  listLeads: "listando leads",
  getLeadDetail: "abrindo lead",
  searchContacts: "buscando contatos",
  getDashboardStats: "calculando métricas",
  listTeamMembers: "consultando a equipe",
  listBoardsAndStages: "consultando pipelines",
  listQuickReplies: "consultando respostas rápidas",
  listTasks: "listando tarefas",
  getAttendantConfig: "lendo o atendente",
  getAttendantSetupGuide: "consultando o guia do atendente",
  updateAttendantPersona: "propondo ajuste no atendente",
  updateAttendantKnowledge: "propondo ajuste no conhecimento do atendente",
  setAttendantMode: "propondo o modo do atendente",
  setAttendantHours: "propondo o horário do atendente",
  setHandoffRules: "propondo regras de repasse",
  setFollowUpSettings: "propondo ajuste de follow-up",
  setAiFeatures: "propondo ajuste de áudio e imagens",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

const SITE_URL = ((import.meta.env.VITE_CONVEX_URL as string) ?? "").replace(
  ".convex.cloud",
  ".convex.site"
);

function threadStorageKey(organizationId: string, purpose?: string): string {
  return `hnbcrm_copilot_thread_${purpose ? `${purpose}_` : ""}${organizationId}`;
}

type CopilotSSEEvent =
  | { type: "thread"; threadId: string }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string }
  | { type: "done" }
  | { type: "error"; message: string };

interface UseCopilotStreamResult {
  /** Texto do turno em streaming (acumulado a partir dos eventos "delta"). */
  streamingText: string;
  /** Nomes das tools acionadas no turno em streaming. */
  activeTools: string[];
  isStreaming: boolean;
  error: string | null;
  threadId: Id<"copilotThreads"> | null;
  sendMessage: (text: string) => Promise<void>;
  /** Limpa a thread atual (guardada em localStorage por organização). */
  startNewThread: () => void;
}

export interface UseCopilotStreamOptions {
  purpose?: "setup";
  /** Thread guardada no servidor (usada se o navegador não tiver uma). */
  initialThreadId?: string | null;
  /** A thread da conversa mudou (criada ou descartada). */
  onThreadChange?: (threadId: string | null) => void;
}

export function useCopilotStream(
  organizationId: Id<"organizations">,
  options?: UseCopilotStreamOptions
): UseCopilotStreamResult {
  const purpose = options?.purpose;
  const token = useAuthToken();
  // Thread guardada fora do navegador (ex.: wizard de configuração): vale quando o
  // localStorage não tem nenhuma.
  const initialThreadRef = useRef(options?.initialThreadId ?? null);
  const onThreadChangeRef = useRef(options?.onThreadChange);
  onThreadChangeRef.current = options?.onThreadChange;

  const [threadId, setThreadId] = useState<Id<"copilotThreads"> | null>(() => {
    if (typeof window === "undefined") return null;
    const stored = window.localStorage.getItem(threadStorageKey(organizationId, purpose));
    return (stored as Id<"copilotThreads"> | null) ?? (initialThreadRef.current as Id<"copilotThreads"> | null);
  });
  const [streamingText, setStreamingText] = useState("");
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  // Cada organização tem sua própria thread persistida — recarrega ao trocar de org.
  useEffect(() => {
    const stored = window.localStorage.getItem(threadStorageKey(organizationId, purpose));
    setThreadId(
      (stored as Id<"copilotThreads"> | null) ?? (initialThreadRef.current as Id<"copilotThreads"> | null),
    );
  }, [organizationId, purpose]);

  // Avisa quem guarda a thread fora do navegador, só quando ela muda de fato.
  const reportedThreadRef = useRef<string | null>(initialThreadRef.current);
  useEffect(() => {
    if (reportedThreadRef.current === threadId) return;
    reportedThreadRef.current = threadId;
    onThreadChangeRef.current?.(threadId);
  }, [threadId]);

  const startNewThread = useCallback(() => {
    window.localStorage.removeItem(threadStorageKey(organizationId, purpose));
    setThreadId(null);
    setStreamingText("");
    setActiveTools([]);
    setError(null);
  }, [organizationId, purpose]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;
      if (!token) {
        toast.error("Sessão expirada — faça login novamente");
        return;
      }

      setStreamingText("");
      setActiveTools([]);
      setError(null);
      setIsStreaming(true);

      try {
        const res = await fetch(`${SITE_URL}/api/copilot/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            organizationId,
            threadId: threadIdRef.current ?? undefined,
            message: trimmed,
            ...(purpose ? { purpose } : {}),
          }),
        });

        if (!res.ok || !res.body) {
          let message = "Não foi possível conectar com o copiloto.";
          try {
            const data = await res.json();
            if (typeof data?.error === "string") message = data.error;
          } catch {
            // resposta não era JSON — mantém a mensagem genérica
          }
          throw new Error(message);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Mantém a última linha (possivelmente parcial) no buffer entre chunks.
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice("data: ".length).trim();
            if (!raw) continue;

            let event: CopilotSSEEvent;
            try {
              event = JSON.parse(raw);
            } catch {
              continue;
            }

            switch (event.type) {
              case "thread":
                setThreadId(event.threadId as Id<"copilotThreads">);
                window.localStorage.setItem(
                  threadStorageKey(organizationId, purpose),
                  event.threadId
                );
                break;
              case "delta":
                setStreamingText((prev) => prev + event.text);
                break;
              case "tool":
                setActiveTools((prev) =>
                  prev.includes(event.name) ? prev : [...prev, event.name]
                );
                break;
              case "error":
                setError(event.message);
                toast.error(event.message);
                break;
              case "done":
                break;
            }
          }
        }
      } catch (e) {
        const message =
          e instanceof Error ? e.message : "Erro inesperado ao falar com o copiloto";
        setError(message);
        toast.error(message);
      } finally {
        setIsStreaming(false);
      }
    },
    [isStreaming, organizationId, token, purpose]
  );

  return {
    streamingText,
    activeTools,
    isStreaming,
    error,
    threadId,
    sendMessage,
    startNewThread,
  };
}
