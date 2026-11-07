import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthToken } from "@convex-dev/auth/react";
import { toast } from "sonner";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import {
  copilotThreadKey,
  readCopilotThread,
  shouldRetryWithoutThread,
  removeCopilotThread,
  removeLegacyCopilotThreads,
  writeCopilotThread,
} from "@/lib/copilotThreadStorage";

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
  /** Limpa a thread atual (guardada em localStorage por usuário e organização). */
  startNewThread: () => void;
  /** Descarta a thread atual em silêncio (ex.: o servidor disse que não é desta conta). */
  discardThread: () => void;
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

  // A chave da thread inclui o usuário; sem ele (carregando) não há o que ler.
  const loggedInUser = useQuery(api.auth.loggedInUser);
  const userId: string | undefined = loggedInUser?._id;
  const storageKey = userId ? copilotThreadKey(userId, organizationId, purpose) : null;
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;

  const [threadId, setThreadId] = useState<Id<"copilotThreads"> | null>(
    (initialThreadRef.current as Id<"copilotThreads"> | null) ?? null
  );
  const [streamingText, setStreamingText] = useState("");
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  // Cada usuário/organização tem sua própria thread persistida — recarrega ao trocar.
  useEffect(() => {
    removeLegacyCopilotThreads(organizationId);
    if (!storageKey) return;
    const stored = readCopilotThread(storageKey);
    const fallback = initialThreadRef.current as Id<"copilotThreads"> | null;
    // Só sobrescreve se ainda não há thread ou ela é a inicial (não pisa numa thread criada nesse meio-tempo).
    setThreadId((current) =>
      current === null || current === fallback ? ((stored as Id<"copilotThreads"> | null) ?? fallback) : current
    );
  }, [organizationId, storageKey]);

  // Avisa quem guarda a thread fora do navegador, só quando ela muda de fato.
  const reportedThreadRef = useRef<string | null>(initialThreadRef.current);
  useEffect(() => {
    if (reportedThreadRef.current === threadId) return;
    reportedThreadRef.current = threadId;
    onThreadChangeRef.current?.(threadId);
  }, [threadId]);

  const discardThread = useCallback(() => {
    if (storageKeyRef.current) removeCopilotThread(storageKeyRef.current);
    initialThreadRef.current = null;
    threadIdRef.current = null;
    setThreadId(null);
  }, []);

  const startNewThread = useCallback(() => {
    discardThread();
    setStreamingText("");
    setActiveTools([]);
    setError(null);
  }, [discardThread]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;
      if (!token) {
        toast.error("Sessão expirada — faça login novamente");
        return;
      }
      // Sem o usuário carregado não dá para guardar nem ler a thread: não envia ainda.
      if (!storageKeyRef.current) {
        toast.error("Aguarde um instante e tente de novo.");
        return;
      }

      setStreamingText("");
      setActiveTools([]);
      setError(null);
      setIsStreaming(true);

      try {
        let res: Response | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          res = await fetch(`${SITE_URL}/api/copilot/stream`, {
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

          if (res.ok && res.body) break;
          let message = "Não foi possível conectar com o copiloto.";
          let code: string | undefined;
          try {
            const data = await res.json();
            if (typeof data?.error === "string") message = data.error;
            if (typeof data?.code === "string") code = data.code;
          } catch {
            // resposta não era JSON — mantém a mensagem genérica
          }
          // Thread de outra conta (guardada neste navegador): descarta e reenvia UMA vez sem thread.
          if (shouldRetryWithoutThread(res.status, code, attempt)) {
            discardThread();
            continue;
          }
          throw new Error(message);
        }
        if (!res || !res.ok || !res.body) throw new Error("Não foi possível conectar com o copiloto.");

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
                if (storageKeyRef.current) writeCopilotThread(storageKeyRef.current, event.threadId);
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
    [isStreaming, organizationId, token, purpose, discardThread]
  );

  return {
    streamingText,
    activeTools,
    isStreaming,
    error,
    threadId,
    sendMessage,
    startNewThread,
    discardThread,
  };
}
