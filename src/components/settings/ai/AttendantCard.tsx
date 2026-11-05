import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { Bot, FlaskConical } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { Select } from "@/components/ui/Select";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { Badge } from "@/components/ui/Badge";
import { useOrgModules } from "@/hooks/useOrgModules";
import { usePermissions } from "@/hooks/usePermissions";
import { TAB_ROUTES } from "@/lib/routes";
import { modeFromProfile, modeToPatch, type AttendantMode } from "@/lib/attendantConfig";
import { VOCAB } from "@/lib/vocab";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { PERSONAS } from "./aiTypes";
import { Attendant } from "../attendant/types";
import { AttendantModeSwitch } from "../attendant/AttendantModeSwitch";
import { SimulatorModal } from "./SimulatorModal";

// ── Atendente IA: criação em 1 toque, status, teste e modo ──

export function AttendantCard({ organizationId }: { organizationId: Id<"organizations"> }) {
  const attendants = useQuery(api.aiSettings.listAttendants, { organizationId }) as
    | Attendant[]
    | undefined;
  const createAttendant = useMutation(api.aiSettings.createAttendantOneClick);
  const [personaId, setPersonaId] = useState("");
  const [busy, setBusy] = useState(false);

  const handleCreate = async () => {
    setBusy(true);
    try {
      await createAttendant({
        organizationId,
        ...(personaId ? { personaId } : {}),
      });
      toast.success("Atendente IA criado em modo Sugerir respostas");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível criar atendente.");
    } finally {
      setBusy(false);
    }
  };

  if (attendants === undefined) {
    return (
      <Card>
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      </Card>
    );
  }

  if (attendants.length === 0) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 shrink-0 rounded-full bg-ai-500/10 flex items-center justify-center">
            <Bot size={20} className="text-ai-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-semibold text-text-primary">{VOCAB.attendant.name}</h3>
            <p className="text-sm text-text-secondary mt-1 mb-4">
              Nasce pronto: jeito de atender pelo seu ramo, o que a IA sabe do seu negócio a partir
              das suas respostas rápidas, horário comercial. Começa em{" "}
              <strong>Sugerir respostas</strong>: cada resposta vira uma resposta sugerida que sua
              equipe aprova antes de enviar. Funciona em canais WhatsApp oficiais (Meta).
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                  Jeito de atender
                </label>
                <Select
                  className="w-auto"
                  value={personaId}
                  onValueChange={setPersonaId}
                  options={[
                    { value: "", label: "Automática (pelo meu ramo)" },
                    ...PERSONAS.map((p) => ({ value: p.id, label: p.label })),
                  ]}
                />
              </div>
              <Button onClick={() => void handleCreate()} disabled={busy}>
                <Bot size={16} className="mr-1.5" />
                Ativar atendente
              </Button>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <>
      {attendants.map((attendant) => (
        <AttendantStatus key={attendant._id} organizationId={organizationId} attendant={attendant} />
      ))}
    </>
  );
}

/** Status do atendente: nome, modo, funil dos leads novos, teste da IA e troca de modo. */
function AttendantStatus({
  organizationId,
  attendant,
}: {
  organizationId: Id<"organizations">;
  attendant: Attendant;
}) {
  const navigate = useNavigate();
  const { modules } = useOrgModules(organizationId);
  const { can } = usePermissions(organizationId);
  const canManage = can("settings", "manage");
  const metrics = useQuery(api.aiSettings.getAttendantMetrics, { organizationId, agentMemberId: attendant._id });
  const updateProfile = useMutation(api.aiSettings.updateAgentProfile);
  const [showSimulator, setShowSimulator] = useState(false);
  const profile = attendant.agentProfile;
  const mode = modeFromProfile(profile);
  const isAutopilot = mode === "autopilot";
  const boardId = profile.pipelineConfig?.boardId;
  const boards = useQuery(api.boards.getBoards, boardId ? { organizationId } : "skip") as
    | { _id: Id<"boards">; name: string }[]
    | undefined;
  const stages = useQuery(api.boards.getStages, boardId ? { boardId } : "skip") as
    | { _id: Id<"stages">; name: string }[]
    | undefined;
  const boardName = boards?.find((b) => b._id === boardId)?.name;
  const stageName = stages?.find((s) => s._id === profile.pipelineConfig?.initialStageId)?.name;

  const changeMode = async (next: AttendantMode) => {
    try {
      await updateProfile({ agentMemberId: attendant._id, patch: modeToPatch(next) });
      toast.success(
        next === "suggest"
          ? "Voltou para Sugerir respostas"
          : "Responder sozinha ativado. As respostas saem sem revisão",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível alterar o modo.");
    }
  };

  const earlyAutopilot = async () => {
    try {
      await updateProfile({
        agentMemberId: attendant._id,
        patch: modeToPatch("autopilot"),
        autopilotRiskAck: true,
      });
      toast.success("Responder sozinha ativado antes da hora. As respostas saem sem revisão");
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível ativar Responder sozinha.");
      return false;
    }
  };

  return (
    <Card>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-10 w-10 shrink-0 rounded-full bg-ai-500/10 flex items-center justify-center">
            <Bot size={20} className="text-ai-400" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-lg font-semibold text-text-primary">{attendant.name}</h3>
              <Badge variant={isAutopilot ? "warning" : "info"}>
                {isAutopilot ? VOCAB.attendant.modeAuto : VOCAB.attendant.modeSuggest}
              </Badge>
            </div>
            <p className="text-sm text-text-secondary mt-1">
              {isAutopilot
                ? "Responde clientes sozinha e chama a equipe quando precisa."
                : "Sugere respostas que sua equipe revisa e envia: nada sai sozinho."}
            </p>
            {boardId ? (
              <button
                type="button"
                onClick={() => navigate(`${TAB_ROUTES.board}?board=${boardId}`)}
                className="mt-1.5 block text-left text-xs text-text-muted hover:text-brand-500 transition-colors"
              >
                Leads novos caem em:{" "}
                <span className="font-medium text-text-secondary">{boardName ?? "…"}</span>
                {" → "}
                <span className="font-medium text-text-secondary">{stageName ?? "primeira etapa"}</span>
              </button>
            ) : (
              <p className="mt-1.5 text-xs text-text-muted">Leads novos caem no funil padrão.</p>
            )}
            {modules.metaMessaging && profile.disclosureMode === "on_demand" && (
              <p className="mt-1.5 text-xs text-text-muted">
                No Instagram e no Messenger a divulgação sob demanda depende de o cliente perguntar; considere
                "sempre" para esses canais.
              </p>
            )}
          </div>
        </div>
        <Button variant="secondary" onClick={() => setShowSimulator(true)}>
          <FlaskConical size={15} className="mr-1.5" />
          Testar a IA
        </Button>
      </div>

      <div className="mt-4">
        <AttendantModeSwitch
          value={mode}
          onChange={(next) => void changeMode(next)}
          metrics={metrics}
          earlyAckAt={profile.autopilotEarlyAck?.acceptedAt}
          disabled={!canManage}
          onEarlyAutopilot={canManage ? earlyAutopilot : undefined}
        />
        {!canManage && (
          <p className="mt-2 text-xs text-text-muted">Só quem gerencia as configurações pode trocar o modo.</p>
        )}
        {(isAutopilot || metrics?.autopilotUnlocked) && (
          <p className="mt-2 text-xs text-text-muted">
            Em Responder sozinha, considere definir um horário de atendimento (
            <Link to={`${TAB_ROUTES.settings}?secao=ai-attendant`} className="font-medium text-brand-500 hover:text-brand-400">
              Jeito de atender
            </Link>
            ) se não quiser envios de madrugada.
          </p>
        )}
      </div>

      {showSimulator && (
        <SimulatorModal
          metaEnabled={modules.metaMessaging}
          organizationId={organizationId}
          agentMemberId={attendant._id}
          onClose={() => setShowSimulator(false)}
        />
      )}
    </Card>
  );
}
