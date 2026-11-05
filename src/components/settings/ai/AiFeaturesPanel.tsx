import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Bot, Eye, Mic, Send, Sparkles, Users } from "lucide-react";
import { buttonClassName } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { usePermissions } from "@/hooks/usePermissions";
import { countActiveAttendants, pickEditableAttendant } from "@/lib/attendantConfig";
import { TAB_ROUTES } from "@/lib/routes";
import { VOCAB } from "@/lib/vocab";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ExternalAgendaSection } from "../ExternalAgendaSection";
import { MultiAttendantNotice } from "../attendant/MultiAttendantNotice";
import { ChannelTranscriptionToggle } from "../channels/ChannelTranscriptionToggle";
import type { Attendant } from "../attendant/types";
import { BridgeAiCard } from "./BridgeAiCard";
import { FeatureToggleCard } from "./FeatureToggleCard";

type ChannelRow = {
  _id: Id<"channelConfigs">;
  channel: string;
  displayName: string;
  displayPhoneNumber: string | null;
  autoTranscribeAudio: boolean;
};

type Toggles = {
  copilotEnabled?: boolean;
  attendantEnabled?: boolean;
  visionEnabled?: boolean;
  groupAgentEnabled?: boolean;
};

/** Painel `ai-features`: o que a IA pode fazer (sem os seletores de modelo, que ficam em Avançado). */
export function AiFeaturesPanel({ organizationId }: { organizationId: Id<"organizations"> }) {
  const status = useQuery(api.aiSettings.getAiStatus, { organizationId });
  const channels = useQuery(api.channelConfigs.getChannelConfigs, { organizationId }) as ChannelRow[] | undefined;
  const attendants = useQuery(api.aiSettings.listAttendants, { organizationId }) as Attendant[] | undefined;
  const setFeatureToggles = useMutation(api.aiSettings.setFeatureToggles);
  const { can } = usePermissions(organizationId);
  const [busy, setBusy] = useState(false);

  if (!status) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  const canManage = can("settings", "manage");
  const whatsapp = (channels ?? []).filter((c) => c.channel === "whatsapp");
  const attendant = pickEditableAttendant(attendants);

  const toggle = async (args: Toggles, okMessage: string) => {
    setBusy(true);
    try {
      await setFeatureToggles({ organizationId, ...args });
      toast.success(okMessage);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível alterar.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {attendant && <MultiAttendantNotice count={countActiveAttendants(attendants)} name={attendant.name} />}
      <FeatureToggleCard
        icon={Mic}
        title="Ouvir áudios (transcrição)"
        description="Transforma os áudios dos contatos em texto para a equipe e para o Atendente IA. A escolha é por número."
      >
        {channels === undefined ? (
          <Spinner size="sm" />
        ) : whatsapp.length === 0 ? (
          <p className="text-xs text-text-muted">
            Nenhum número conectado.{" "}
            <Link to={`${TAB_ROUTES.settings}?secao=channels`} className="font-medium text-brand-500 hover:text-brand-400">
              Conectar um número
            </Link>
          </p>
        ) : (
          whatsapp.map((c) => (
            <div key={c._id} className="space-y-1.5">
              <p className="text-xs font-medium text-text-secondary">
                {c.displayName}
                {c.displayPhoneNumber ? ` · ${c.displayPhoneNumber}` : ""}
              </p>
              <ChannelTranscriptionToggle
                organizationId={organizationId}
                configId={c._id}
                checked={c.autoTranscribeAudio}
                description={null}
              />
            </div>
          ))
        )}
      </FeatureToggleCard>

      {!status.active ? (
        <EmptyState
          icon={Bot}
          size="sm"
          title="Ligue o Atendente IA primeiro"
          description="Ler imagens, IA em grupos e Copiloto aparecem depois que a IA está ativa."
          action={{ label: "Ir para a visão geral", href: `${TAB_ROUTES.settings}?secao=ai` }}
        />
      ) : (
        <>
      <FeatureToggleCard
        icon={Eye}
        title="Ler imagens"
        description="A IA descreve comprovantes, documentos e fotos que o cliente enviar. Cada imagem vai uma única vez ao provedor e o texto lido fica salvo. Vem desligado."
        costLabel="Custo medido: cerca de US$ 0,0003 por imagem"
        checked={status.visionEnabled}
        disabled={busy || !canManage}
        onChange={(next) =>
          void toggle(
            { visionEnabled: next },
            next ? "Leitura de imagens ativada" : "Leitura de imagens desativada",
          )
        }
      />

      <FeatureToggleCard
        icon={Users}
        title="IA em grupos de WhatsApp"
        description="Responde quando mencionada no grupo, resume a conversa e aponta oportunidades. Nunca manda mensagem privada sozinha. Cada grupo é configurado à parte e vem desligado. Também libera o texto das publicações programadas."
        checked={status.groupAgentEnabled}
        disabled={busy || !canManage}
        onChange={(next) =>
          void toggle({ groupAgentEnabled: next }, next ? "IA em grupos ativada" : "IA em grupos desativada")
        }
      />

      <FeatureToggleCard
        icon={Bot}
        title={VOCAB.attendant.name}
        description="Responde clientes no WhatsApp. Começa em Sugerir respostas, com revisão da equipe."
        checked={status.attendantEnabled}
        disabled={busy || !canManage}
        onChange={(next) =>
          void toggle({ attendantEnabled: next }, next ? "Atendente IA ativado" : "Atendente IA desativado")
        }
      />

      <BridgeAiCard organizationId={organizationId} status={status} />

      <FeatureToggleCard
        icon={Sparkles}
        title={VOCAB.copilot.name}
        description="Assistente no app para a sua equipe: lê e edita o CRM conforme a permissão de cada pessoa."
        checked={status.copilotEnabled}
        disabled={busy || !canManage}
        onChange={(next) => void toggle({ copilotEnabled: next }, next ? "Copiloto ativado" : "Copiloto desativado")}
      />

      <FeatureToggleCard
        icon={Send}
        title="Copiloto no Telegram"
        description="A equipe fala com o Copiloto pelo Telegram. A conexão e os avisos ficam em Notificações."
      >
        <Link to={`${TAB_ROUTES.settings}?secao=notifications`} className={buttonClassName("secondary", "sm")}>
          Abrir Notificações
        </Link>
      </FeatureToggleCard>

        </>
      )}

      {status.active && attendant && <ExternalAgendaSection organizationId={organizationId} agentMemberId={attendant._id} />}
    </div>
  );
}
