import { useState } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { Send, Mic, Image as ImageIcon, FileText } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

// ── Simulador "testar antes de ativar" (sandbox — não toca o WhatsApp) ──

// Tipos de mensagem que o simulador sabe encenar. Existem para o botão "Testar"
// conseguir exercitar os caminhos de mídia — antes só dava para validar a
// persona contra um comprovante mandando do celular de verdade.
export type SimKind = "text" | "audio" | "image" | "file";

export type SimTurn = {
  role: "customer" | "agent";
  content: string;
  audio?: boolean;
  image?: boolean;
  file?: boolean;
  /** Quem falou, no modo grupo — a IA responde "só a quem perguntou". */
  senderName?: string;
  actions?: string[];
};

/** Sala fictícia do modo grupo do simulador. */
export const SIM_GROUP = { subject: "Grupo de clientes (teste)", participantsCount: 12 };

export const SIM_KINDS: Array<{
  kind: Exclude<SimKind, "text">;
  Icon: typeof Mic;
  label: string;
  hint: string;
  placeholder: string;
}> = [
  {
    kind: "audio",
    Icon: Mic,
    label: "nota de voz (transcrita)",
    hint: "Enviar como nota de voz — o texto vira a transcrição",
    placeholder: "Transcrição da nota de voz…",
  },
  {
    kind: "image",
    Icon: ImageIcon,
    label: "imagem (lida pela IA)",
    hint: "Enviar como imagem — o texto vira a descrição que a leitura de imagens produziria",
    placeholder: "O que a IA leu na imagem (ex.: comprovante de Pix de R$ 1.247,90 em 26/08)...",
  },
  {
    kind: "file",
    Icon: FileText,
    label: "arquivo (só o nome chega)",
    hint: "Enviar como arquivo — só o NOME chega à IA, que não consegue abrir o conteúdo",
    placeholder: "Nome do arquivo (ex.: comprovante-pix.pdf)...",
  },
];

export type SimTransport = "meta" | "bridge" | "instagram" | "messenger";

export const SIM_TRANSPORT_OPTIONS: Array<{ value: SimTransport; label: string }> = [
  { value: "meta", label: "WhatsApp oficial (Meta)" },
  { value: "bridge", label: "WhatsApp por QR code" },
  { value: "instagram", label: "Instagram" },
  { value: "messenger", label: "Messenger" },
];

export function SimulatorModal({
  organizationId,
  agentMemberId,
  metaEnabled,
  onClose,
}: {
  metaEnabled: boolean;
  organizationId: Id<"organizations">;
  agentMemberId: Id<"teamMembers">;
  onClose: () => void;
}) {
  const simulate = useAction(api.attendant.simulateAttendant);
  const [transcript, setTranscript] = useState<SimTurn[]>([]);
  const [input, setInput] = useState("");
  const [kind, setKind] = useState<SimKind>("text");
  // Modo GRUPO: troca o prompt e as tools pelos do agente de grupo (F4). É a
  // única forma de validar "não confirme pagamento no grupo" e "assunto
  // individual vai para o privado" sem mandar mensagem numa sala de verdade.
  const [groupMode, setGroupMode] = useState(false);
  const [senderName, setSenderName] = useState("Eric");
  const [busy, setBusy] = useState(false);
  const [transport, setTransport] = useState<SimTransport>("meta");
  const plainTextChannel = transport === "instagram" || transport === "messenger";

  const handleSend = async () => {
    const text = input.trim();
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
        setTranscript((prev) => [
          ...prev,
          { role: "agent", content: result.reply!, actions: result.actions },
        ]);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha na simulação");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={groupMode ? "Simulador — testar num grupo" : "Simulador — testar o atendente"}
    >
      <div className="space-y-3">
        <p className="text-xs text-text-muted">
          Sandbox: nada aqui toca o WhatsApp nem altera dados do CRM. Escreva como se fosse o
          cliente. Os três botões ao lado do campo trocam o tipo de mensagem: nota de voz (o
          texto vira a transcrição), imagem (o texto vira a descrição que a leitura de imagens
          produziria) e arquivo (só o nome chega à IA, como acontece com um PDF de verdade).
        </p>
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-sunken p-2.5">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-text-primary">
            <input
              type="checkbox"
              checked={groupMode}
              onChange={(e) => {
                setGroupMode(e.target.checked);
                setTranscript([]);
              }}
              className="h-4 w-4 accent-brand-600"
            />
            Simular dentro de um grupo
          </label>
          {groupMode && (
            <>
              <input
                value={senderName}
                onChange={(e) => setSenderName(e.target.value)}
                placeholder="Quem está falando"
                aria-label="Nome do membro que está falando"
                className="w-40 px-2.5 py-1.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-xs focus:outline-none focus:border-brand-500"
              />
              <span className="text-[11px] text-text-muted">
                Usa as regras da sala: sem dado de outro cliente, sem confirmar pagamento,
                assunto individual vai para o privado.
              </span>
            </>
          )}
        </div>
        {metaEnabled && (
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="sim-transport" className="text-xs text-text-muted">
              Canal simulado
            </label>
            <select
              id="sim-transport"
              value={transport}
              onChange={(e) => {
                setTransport(e.target.value as SimTransport);
                setTranscript([]);
              }}
              className="min-h-[44px] px-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-xs focus:outline-none focus:border-brand-500"
            >
              {SIM_TRANSPORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {plainTextChannel && (
              <span className="text-[11px] text-text-muted">
                Neste canal a resposta sai em texto puro, sem a formatação do WhatsApp (negrito,
                itálico, listas com marcadores).
              </span>
            )}
          </div>
        )}
        <div className="h-72 overflow-y-auto space-y-2 rounded-lg bg-surface-sunken p-3">
          {transcript.length === 0 && (
            <p className="text-sm text-text-muted text-center py-8">
              Ex.: "Oi, queria saber os preços"
            </p>
          )}
          {transcript.map((m, i) => (
            <div key={i} className={cn("flex", m.role === "customer" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap",
                  m.role === "customer"
                    ? "bg-brand-600 text-white"
                    : "bg-ai-600/20 text-text-primary border border-ai-500/30"
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
                  <div className="mt-2 pt-2 border-t border-ai-500/30">
                    {m.actions.map((a, j) => (
                      <p key={j} className="text-xs text-ai-300">
                        {/* v4.2: o backend manda rótulo humano com os VALORES
                            (ex.: 'Atualizar lead: cerimonia = X') — mostre inteiro;
                            formato legado name(args) cai no nome limpo. */}
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
              <div className="rounded-xl px-3 py-2 bg-ai-600/10">
                <Spinner size="sm" />
              </div>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {SIM_KINDS.map(({ kind: k, Icon, hint }) => (
            <button
              key={k}
              type="button"
              role="switch"
              aria-checked={kind === k}
              aria-label={hint}
              title={hint}
              onClick={() => setKind((prev) => (prev === k ? "text" : k))}
              className={cn(
                "px-3 rounded-field border transition-colors",
                kind === k
                  ? "bg-brand-600 border-brand-600 text-white"
                  : "bg-surface-raised border-border-strong text-text-muted hover:text-text-primary"
              )}
            >
              <Icon size={15} />
            </button>
          ))}
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSend();
            }}
            placeholder={
              SIM_KINDS.find((k) => k.kind === kind)?.placeholder ?? "Mensagem do cliente..."
            }
            className="flex-1 px-3.5 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:border-brand-500"
          />
          <Button onClick={() => void handleSend()} disabled={busy || !input.trim()}>
            <Send size={15} />
          </Button>
        </div>
      </div>
    </Modal>
  );
}
