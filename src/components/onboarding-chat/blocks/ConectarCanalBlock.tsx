import { useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { toast } from "sonner";
import { CheckCircle2, MessageCircle, TriangleAlert } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ChannelConnectCard } from "@/components/settings/channels/ChannelConnectCard";
import { AttendantModeSwitch } from "@/components/settings/attendant/AttendantModeSwitch";
import { useAttendantProfile } from "@/components/settings/attendant/useAttendantProfile";
import { modeToPatch, type AttendantMode } from "@/lib/attendantConfig";
import { mutationErrorMessage } from "@/lib/errors";
import { VOCAB } from "@/lib/vocab";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

export interface ConectarCanalViewProps {
  note?: string;
  compact?: boolean;
  connected: boolean;
  /** `ChannelConnectCard` (única porta para conectar número). */
  connectCard?: ReactNode;
  /** Escolha de modo do atendente (só depois de conectar, com aviso e aceite no modal). */
  modeChoice?: ReactNode;
}

/**
 * `conectarCanal`: leva ao fluxo de sempre para conectar o número. Avisa com
 * honestidade sobre o QR code. Depois de conectado, o atendente continua em
 * Sugerir respostas; Responder sozinha é escolha explícita, com aviso e aceite.
 */
export function ConectarCanalView({ note, compact, connected, connectCard, modeChoice }: ConectarCanalViewProps) {
  return (
    <BlockCard title="Conectar o WhatsApp" icon={MessageCircle} note={compact ? undefined : note}>
      {!connected && (
        <div className="space-y-2">
          <p className="text-text-secondary">
            Você escolhe como conectar: pelo WhatsApp oficial (Meta), que é o recomendado, ou por QR code, lendo o código no celular.
          </p>
          <p className="flex items-start gap-1.5 rounded-field bg-semantic-warning/10 px-2 py-1.5 text-caption text-text-primary">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-semantic-warning" aria-hidden="true" />
            <span>
              Por QR code a conexão não é aprovada pela Meta: o número pode ser banido. Use um número dedicado, nunca o principal do
              seu negócio. Você confirma isso antes de conectar.
            </span>
          </p>
          {connectCard}
        </div>
      )}
      {connected && (
        <div className="space-y-3">
          <p role="status" className="flex items-center gap-1.5 font-medium text-text-primary">
            <CheckCircle2 className="size-4 text-semantic-success" aria-hidden="true" />
            Número conectado.
          </p>
          {modeChoice}
        </div>
      )}
    </BlockCard>
  );
}

/** Modo do atendente depois de conectar: começa em Sugerir; Responder sozinha só pelo aceite de risco do fluxo existente. */
function ModeChoice({ organizationId }: { organizationId: Id<"organizations"> }) {
  const profile = useAttendantProfile(organizationId);
  const attendant = profile.attendant;
  const metrics = useQuery(
    api.aiSettings.getAttendantMetrics,
    attendant && profile.status?.active ? { organizationId, agentMemberId: attendant._id } : "skip"
  );
  if (!attendant || !profile.status?.active) {
    return (
      <p className="text-text-secondary">
        Quando o atendente estiver ativo, ele começa em {VOCAB.attendant.modeSuggest}: ele escreve e a sua equipe revisa.
      </p>
    );
  }
  const mode: AttendantMode = attendant.agentProfile.mode === "autopilot" ? "autopilot" : "suggest";
  const change = async (next: AttendantMode) => {
    try {
      await profile.save(modeToPatch(next));
      toast.success(next === "suggest" ? `Voltou para ${VOCAB.attendant.modeSuggest}` : `${VOCAB.attendant.modeAuto} ativado`);
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível alterar o modo."));
    }
  };
  return (
    <div className="space-y-2">
      <p className="text-text-secondary">
        {mode === "autopilot"
          ? `${VOCAB.attendant.modeAuto} está ligado: as respostas saem sem revisão.`
          : `Seu atendente começa em ${VOCAB.attendant.modeSuggest}: nada sai sozinho para um cliente. Você pode mudar depois de conhecer o jeito dele.`}
      </p>
      <AttendantModeSwitch
        value={mode}
        onChange={(next) => void change(next)}
        variant="wizard"
        disabled={!profile.canManage}
        metrics={
          metrics ?? { reviewed: 0, acceptanceRate: 0, proactive: 0, autopilotUnlocked: false }
        }
        earlyAckAt={attendant.agentProfile.autopilotEarlyAck?.acceptedAt}
        onEarlyAutopilot={async () => {
          try {
            await profile.save(modeToPatch("autopilot"), { autopilotRiskAck: true });
            toast.success(`${VOCAB.attendant.modeAuto} ativado antes da hora. As respostas saem sem revisão`);
            return true;
          } catch (e) {
            toast.error(mutationErrorMessage(e, `Não foi possível ativar ${VOCAB.attendant.modeAuto}.`));
            return false;
          }
        }}
      />
    </div>
  );
}

export function ConectarCanalBlock({ block, ctx }: BlockProps<"conectarCanal">) {
  const organizationId = ctx.organizationId as Id<"organizations"> | null;
  const [connected, setConnected] = useState(false);
  return (
    <ConectarCanalView
      note={block.note}
      compact={ctx.compact}
      connected={connected}
      connectCard={
        organizationId ? (
          <ChannelConnectCard organizationId={organizationId} variant="wizard" onConnected={() => setConnected(true)} />
        ) : undefined
      }
      modeChoice={organizationId ? <ModeChoice organizationId={organizationId} /> : undefined}
    />
  );
}
