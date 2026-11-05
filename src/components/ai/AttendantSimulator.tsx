import { useRef, useState } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { Send, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  SIM_GROUP,
  SIM_KINDS,
  SIM_TRANSPORT_OPTIONS,
  type SimKind,
  type SimTransport,
  type SimTurn,
} from "./attendantSimulatorTypes";

// ── Chat simulado da Atendente IA (sandbox: não toca o WhatsApp nem os dados do CRM) ──

export interface AttendantSimulatorViewProps {
  variant: "inline" | "modal";
  transcript: SimTurn[];
  busy: boolean;
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  suggestions?: string[];
  /** Clique numa pergunta sugerida: envia na hora. */
  onSuggestion: (text: string) => void;
  onAdjustPersona?: () => void;
  kind?: SimKind;
  onKindChange?: (kind: SimKind) => void;
  groupMode?: boolean;
  onGroupModeChange?: (value: boolean) => void;
  senderName?: string;
  onSenderNameChange?: (value: string) => void;
  metaEnabled?: boolean;
  transport?: SimTransport;
  onTransportChange?: (value: SimTransport) => void;
}

/** Parte apresentacional do simulador (sem Convex). */
export function AttendantSimulatorView({
  variant,
  transcript,
  busy,
  input,
  onInputChange,
  onSend,
  suggestions,
  onSuggestion,
  onAdjustPersona,
  kind = "text",
  onKindChange,
  groupMode = false,
  onGroupModeChange,
  senderName = "",
  onSenderNameChange,
  metaEnabled = false,
  transport = "meta",
  onTransportChange,
}: AttendantSimulatorViewProps) {
  const advanced = variant === "modal";
  const plainTextChannel = transport === "instagram" || transport === "messenger";

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-muted">
        {advanced
          ? "Sandbox: nada aqui toca o WhatsApp nem altera dados do CRM. Escreva como se fosse o cliente. Os três botões ao lado do campo trocam o tipo de mensagem: nota de voz (o texto vira a transcrição), imagem (o texto vira a descrição que a leitura de imagens produziria) e arquivo (só o nome chega à IA, como acontece com um PDF de verdade)."
          : "Teste sem risco: nada aqui chega a um cliente de verdade nem altera seus dados. Escreva como se fosse o cliente."}
      </p>

      {advanced && onGroupModeChange && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-sunken p-2.5">
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-text-primary">
            <input
              type="checkbox"
              checked={groupMode}
              onChange={(e) => onGroupModeChange(e.target.checked)}
              className="h-4 w-4 accent-brand-600"
            />
            Simular dentro de um grupo
          </label>
          {groupMode && (
            <>
              <input
                value={senderName}
                onChange={(e) => onSenderNameChange?.(e.target.value)}
                placeholder="Quem está falando"
                aria-label="Nome do membro que está falando"
                className="w-40 rounded-field border border-border-strong bg-surface-raised px-2.5 py-1.5 text-xs text-text-primary focus:border-brand-500 focus:outline-none"
              />
              <span className="text-[11px] text-text-muted">
                Usa as regras da sala: sem dado de outro cliente, sem confirmar pagamento, assunto
                individual vai para o privado.
              </span>
            </>
          )}
        </div>
      )}

      {advanced && metaEnabled && onTransportChange && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="sim-transport" className="text-xs text-text-muted">
            Canal simulado
          </label>
          <Select
            className="w-auto"
            id="sim-transport"
            value={transport}
            onValueChange={(v) => onTransportChange(v as SimTransport)}
            options={SIM_TRANSPORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
          {plainTextChannel && (
            <span className="text-[11px] text-text-muted">
              Neste canal a resposta sai em texto puro, sem a formatação do WhatsApp (negrito,
              itálico, listas com marcadores).
            </span>
          )}
        </div>
      )}

      <div
        role="log"
        aria-live="polite"
        aria-label="Conversa simulada"
        className={cn(
          "space-y-2 overflow-y-auto rounded-lg bg-surface-sunken p-3",
          variant === "inline" ? "h-72 supports-[height:100dvh]:h-[min(18rem,45dvh)]" : "h-72",
        )}
      >
        {transcript.length === 0 && (
          <p className="py-8 text-center text-sm text-text-muted">Ex.: "Oi, queria saber os preços"</p>
        )}
        {transcript.map((m, i) => (
          <div key={i} className={cn("flex", m.role === "customer" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm",
                m.role === "customer"
                  ? "bg-brand-600 text-white"
                  : "border border-ai-500/30 bg-ai-600/20 text-text-primary",
              )}
            >
              {(() => {
                const meta = SIM_KINDS.find((k) => m[k.kind]);
                if (!meta) return null;
                return (
                  <span className="mb-1 flex items-center gap-1 text-[11px] opacity-80">
                    <meta.Icon size={11} /> {meta.label}
                  </span>
                );
              })()}
              {m.content}
              {m.actions && m.actions.length > 0 && (
                <div className="mt-2 border-t border-ai-500/30 pt-2">
                  <p className="mb-1 text-[11px] font-medium text-text-muted">A IA faria:</p>
                  {m.actions.map((a, j) => (
                    <p key={j} className="text-xs text-ai-300">
                      {/* O backend manda rótulo humano com os VALORES; o formato legado name(args) cai no nome limpo. */}
                      ⚙ {a.includes("(") && a.endsWith(")") ? a.split("(")[0] : a}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-xl bg-ai-600/10 px-3 py-2 text-xs text-text-muted">
              <Spinner size="sm" />
              <span>Pensando…</span>
            </div>
          </div>
        )}
      </div>

      {suggestions && suggestions.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-text-muted">Pergunte algo que um cliente perguntaria</p>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <Button
                key={s}
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => onSuggestion(s)}
                className="h-auto min-h-8 whitespace-normal py-1.5 text-left"
              >
                {s}
              </Button>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        {advanced &&
          onKindChange &&
          SIM_KINDS.map(({ kind: k, Icon, hint }) => (
            <button
              key={k}
              type="button"
              role="switch"
              aria-checked={kind === k}
              aria-label={hint}
              title={hint}
              onClick={() => onKindChange(kind === k ? "text" : k)}
              className={cn(
                "rounded-field border px-3 transition-colors coarse:min-h-11 coarse:min-w-11",
                kind === k
                  ? "border-brand-600 bg-brand-600 text-white"
                  : "border-border-strong bg-surface-raised text-text-muted hover:text-text-primary",
              )}
            >
              <Icon size={15} />
            </button>
          ))}
        <input
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSend();
          }}
          aria-label="Mensagem do cliente"
          placeholder={SIM_KINDS.find((k) => k.kind === kind)?.placeholder ?? "Mensagem do cliente..."}
          className="min-w-0 flex-1 rounded-field border border-border-strong bg-surface-raised px-3.5 py-2.5 text-sm text-text-primary focus:border-brand-500 focus:outline-none coarse:min-h-11"
        />
        <Button iconOnly aria-label="Enviar mensagem" onClick={onSend} disabled={busy || !input.trim()}>
          <Send size={15} />
        </Button>
      </div>

      {onAdjustPersona && (
        <Button variant="ghost" size="sm" onClick={onAdjustPersona}>
          <SlidersHorizontal size={14} />
          Ajustar jeito de atender
        </Button>
      )}
    </div>
  );
}

export interface AttendantSimulatorProps {
  organizationId: Id<"organizations">;
  agentMemberId: Id<"teamMembers">;
  /** Perguntas prontas (3 por segmento, de `segmentTemplate(key).simulatorPrompts`). */
  suggestions?: string[];
  variant: "inline" | "modal";
  onAdjustPersona?: () => void;
  /** Dispara uma vez, na primeira resposta da IA. */
  onFirstReply?: () => void;
  /** Só no `modal`: fecha o diálogo. */
  onClose?: () => void;
  /** Org com Meta oficial: libera a troca de canal simulado (só `modal`). */
  metaEnabled?: boolean;
}

export function AttendantSimulator({
  organizationId,
  agentMemberId,
  suggestions,
  variant,
  onAdjustPersona,
  onFirstReply,
  onClose,
  metaEnabled = false,
}: AttendantSimulatorProps) {
  const simulate = useAction(api.attendant.simulateAttendant);
  const [transcript, setTranscript] = useState<SimTurn[]>([]);
  const [input, setInput] = useState("");
  const [kind, setKind] = useState<SimKind>("text");
  const [groupMode, setGroupMode] = useState(false);
  const [senderName, setSenderName] = useState("Eric");
  const [busy, setBusy] = useState(false);
  const [transport, setTransport] = useState<SimTransport>("meta");
  const firstReplyFired = useRef(false);

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || busy) return;
    setInput("");
    const next: SimTurn[] = [
      ...transcript,
      {
        role: "customer",
        content: text,
        audio: kind === "audio",
        image: kind === "image",
        file: kind === "file",
        ...(groupMode && senderName.trim() ? { senderName: senderName.trim() } : {}),
      },
    ];
    setTranscript(next);
    setBusy(true);
    try {
      const result = await simulate({
        organizationId,
        agentMemberId,
        transcript: next.map(({ role, content, audio, image, file, senderName: from }) => ({
          role,
          content,
          audio,
          image,
          file,
          senderName: from,
        })),
        ...(groupMode ? { group: SIM_GROUP } : {}),
        ...(metaEnabled && transport !== "meta" ? { transport } : {}),
      });
      if (result.error) {
        toast.error(result.error);
      } else if (result.reply) {
        setTranscript((prev) => [...prev, { role: "agent", content: result.reply!, actions: result.actions }]);
        if (!firstReplyFired.current) {
          firstReplyFired.current = true;
          onFirstReply?.();
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha na simulação");
    } finally {
      setBusy(false);
    }
  };

  const view = (
    <AttendantSimulatorView
      variant={variant}
      transcript={transcript}
      busy={busy}
      input={input}
      onInputChange={setInput}
      onSend={() => void send()}
      suggestions={suggestions}
      onSuggestion={(s) => void send(s)}
      onAdjustPersona={onAdjustPersona}
      kind={kind}
      onKindChange={setKind}
      groupMode={groupMode}
      onGroupModeChange={(v) => {
        setGroupMode(v);
        setTranscript([]);
      }}
      senderName={senderName}
      onSenderNameChange={setSenderName}
      metaEnabled={metaEnabled}
      transport={transport}
      onTransportChange={(v) => {
        setTransport(v);
        setTranscript([]);
      }}
    />
  );

  if (variant === "modal") {
    return (
      <Modal
        open
        onClose={onClose ?? (() => {})}
        title={groupMode ? "Simulador — testar num grupo" : "Simulador — testar o Atendente IA"}
      >
        {view}
      </Modal>
    );
  }
  return <div className="rounded-card border border-border bg-surface-raised p-4">{view}</div>;
}
