import { useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronDown,
  Link2,
  LogOut,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Timer,
  Users,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { PermissionGate } from "@/components/guards/PermissionGate";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Spinner } from "@/components/ui/Spinner";
import { GroupAiPolicyModal } from "@/components/groups/GroupAiPolicyModal";
import type { GroupChatDoc } from "@/components/inbox/types";
import { TAB_ROUTES } from "@/lib/routes";
import { relativeTime } from "@/lib/groupDisplay";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";

/**
 * Painel "Grupos" do card de um número bridge (ao lado do histórico do
 * aparelho, e pelo mesmo motivo: a configuração é POR INSTÂNCIA do gateway).
 *
 * Ligar aqui exige o aceite de risco `bridgeGroupsAck` (D12) — a API é
 * não-oficial, grupo aumenta a exposição a banimento e os membros são
 * terceiros que nunca falaram com a empresa. Avisar e registrar o aceite, não
 * bloquear: a decisão é do operador.
 *
 * Acompanhar continua sendo opt-in POR GRUPO (D4): ligar no número só faz o
 * CRM LISTAR as salas.
 */
export function BridgeGroupsPanel({
  organizationId,
  config,
}: {
  organizationId: Id<"organizations">;
  config: {
    _id: Id<"channelConfigs">;
    displayName: string;
    status: "active" | "disabled" | "error";
    bridgeSessionState: string | null;
  };
}) {
  const navigate = useNavigate();

  const settings = useQuery(api.groupChats.listChannelGroupSettings, { organizationId });
  const mine = settings?.find((s) => s.channelConfigId === config._id);
  const enabled = mine?.groupsEnabled === true;
  const ackDone = (mine?.groupsAckAt ?? null) !== null;

  const groups = useQuery(
    api.groupChats.listGroups,
    enabled ? { organizationId, channelConfigId: config._id } : "skip"
  ) as GroupChatDoc[] | undefined;

  const acceptAck = useMutation(api.groupChats.acceptGroupsAck);
  const setGroupsEnabled = useMutation(api.groupChats.setGroupsEnabled);
  const setMonitored = useMutation(api.groupChats.setMonitored);
  const syncGroups = useAction(api.groupChats.syncGroups);
  const joinByInviteLink = useAction(api.groupChats.joinByInviteLink);
  const leaveGroup = useAction(api.groupChats.leaveGroup);

  const [expanded, setExpanded] = useState(false);
  const [ackOpen, setAckOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [aiGroup, setAiGroup] = useState<GroupChatDoc | null>(null);
  const [confirmLeave, setConfirmLeave] = useState<GroupChatDoc | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const [joinOpen, setJoinOpen] = useState(false);
  const [joinLink, setJoinLink] = useState("");
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinPreview, setJoinPreview] = useState<
    { jid: string; subject: string; participantsCount: number } | null
  >(null);

  const paired = config.bridgeSessionState === "connected";
  const visible = useMemo(
    () => (groups ?? []).filter((g) => g.removedAt === undefined && g.leftAt === undefined),
    [groups]
  );
  const monitoredCount = visible.filter((g) => g.monitored).length;

  const runSync = async (silent = false) => {
    setSyncing(true);
    try {
      const result = await syncGroups({ channelConfigId: config._id });
      if (!silent) toast.success(result.detail);
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao sincronizar os grupos"));
    } finally {
      setSyncing(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!enabled && !ackDone) {
      setAckOpen(true);
      return;
    }
    // Desligar desmarca TODOS os grupos acompanhados e arquiva as conversas —
    // religar não restaura nada. Tudo o mais destrutivo neste painel pergunta
    // antes; justo o que destrói mais ia direto no clique.
    if (enabled && monitoredCount > 0) {
      setConfirmDisable(true);
      return;
    }
    await applyToggleEnabled();
  };

  const applyToggleEnabled = async () => {
    setBusy(true);
    try {
      await setGroupsEnabled({ channelConfigId: config._id, enabled: !enabled });
      if (enabled) {
        toast.success("Grupos desligados neste número");
      } else {
        toast.success("Grupos ligados — buscando a lista de salas");
        setExpanded(true);
        void runSync(true);
      }
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao mudar o interruptor"));
    } finally {
      setBusy(false);
    }
  };

  const handleAccept = async () => {
    setBusy(true);
    try {
      await acceptAck({ channelConfigId: config._id });
      await setGroupsEnabled({ channelConfigId: config._id, enabled: true });
      setAckOpen(false);
      setExpanded(true);
      toast.success("Grupos ligados — buscando a lista de salas");
      void runSync(true);
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao registrar o aceite"));
    } finally {
      setBusy(false);
    }
  };

  const handleToggleMonitored = async (group: GroupChatDoc) => {
    try {
      await setMonitored({
        groupChatId: group._id as Id<"groupChats">,
        monitored: !group.monitored,
      });
      toast.success(
        group.monitored
          ? `Parou de acompanhar '${group.subject}'`
          : `Acompanhando '${group.subject}'`
      );
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao mudar o acompanhamento"));
    }
  };

  const handlePreviewJoin = async () => {
    setJoinBusy(true);
    try {
      const result = await joinByInviteLink({ channelConfigId: config._id, link: joinLink.trim() });
      setJoinPreview(result);
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível ler esse convite"));
    } finally {
      setJoinBusy(false);
    }
  };

  const handleConfirmJoin = async () => {
    setJoinBusy(true);
    try {
      const result = await joinByInviteLink({
        channelConfigId: config._id,
        link: joinLink.trim(),
        confirm: true,
      });
      toast.success(`Entrou em '${result.subject}'`);
      setJoinOpen(false);
      setJoinLink("");
      setJoinPreview(null);
      void runSync(true);
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao entrar no grupo"));
    } finally {
      setJoinBusy(false);
    }
  };

  const handleLeave = async (group: GroupChatDoc) => {
    try {
      const result = await leaveGroup({ groupChatId: group._id as Id<"groupChats"> });
      toast.success(result.detail);
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao sair do grupo"));
    }
  };

  return (
    <div className="mt-3 rounded-lg bg-surface-base border border-border-subtle p-2.5">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          <Users size={15} className="shrink-0 text-text-muted" />
          <span className="min-w-0">
            <span className="block text-sm text-text-primary">Grupos neste número</span>
            <span className="block text-xs text-text-muted mt-0.5">
              {enabled
                ? `${visible.length} grupo(s) · ${monitoredCount} acompanhado(s)`
                : "Acompanhar e responder salas de WhatsApp dentro do CRM"}
            </span>
          </span>
          <ChevronDown
            size={14}
            className={cn(
              "shrink-0 text-text-muted transition-transform",
              expanded && "rotate-180"
            )}
          />
        </button>
        <PermissionGate
          organizationId={organizationId}
          category="settings"
          level="manage"
          fallback={
            <Badge variant={enabled ? "success" : "default"}>
              {enabled ? "Ativado" : "Desativado"}
            </Badge>
          }
        >
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Grupos neste número"
            disabled={busy || settings === undefined}
            onClick={() => void handleToggleEnabled()}
            className={cn(
              "relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50",
              enabled ? "bg-brand-500" : "bg-surface-overlay border border-border-strong"
            )}
          >
            <span
              className={cn(
                "pointer-events-none h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                enabled ? "translate-x-5" : "translate-x-1"
              )}
            />
          </button>
        </PermissionGate>
      </div>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-border-subtle pt-3">
          {!enabled ? (
            <p className="text-xs text-text-muted leading-relaxed">
              Desligado, o CRM não pede nem recebe nada de grupo neste número. Ao
              ligar você aceita o risco de usar grupos numa API não-oficial, e o
              CRM passa a LISTAR as salas — acompanhar cada uma continua sendo
              uma escolha separada.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <PermissionGate organizationId={organizationId} category="settings" level="manage">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={syncing || !paired}
                    onClick={() => void runSync()}
                  >
                    {syncing ? <Spinner size="sm" /> : <RefreshCw size={14} />}
                    Atualizar lista
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setJoinOpen(true)}>
                    <Link2 size={14} />
                    Entrar por link
                  </Button>
                </PermissionGate>
                {mine?.lastSyncAt ? (
                  <span className="text-xs text-text-muted">
                    Atualizado {relativeTime(mine.lastSyncAt)}
                  </span>
                ) : null}
                {!paired && (
                  <span className="text-xs text-text-muted">Número precisa estar conectado</span>
                )}
              </div>

              {groups === undefined ? (
                <div className="flex justify-center py-4">
                  <Spinner size="md" />
                </div>
              ) : visible.length === 0 ? (
                <p className="text-xs text-text-muted">
                  Este número não está em nenhum grupo — ou a lista ainda não foi
                  sincronizada.
                </p>
              ) : (
                <ul className="space-y-2">
                  {visible.map((group) => (
                    <li
                      key={group._id}
                      className="rounded-lg border border-border bg-surface-sunken p-2.5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm font-medium text-text-primary">
                              {group.subject}
                            </span>
                            {group.weAreAdmin && (
                              <Badge variant="info">
                                <span className="inline-flex items-center gap-1">
                                  <ShieldCheck size={10} /> admin
                                </span>
                              </Badge>
                            )}
                            {group.isAnnounce && <Badge variant="warning">anúncio</Badge>}
                            {group.isEphemeral && (
                              <Badge variant="default">
                                <span className="inline-flex items-center gap-1">
                                  <Timer size={10} /> temporárias
                                </span>
                              </Badge>
                            )}
                          </div>
                          <p className="mt-0.5 text-xs text-text-muted tabular-nums">
                            {group.participantsCount} membro
                            {group.participantsCount === 1 ? "" : "s"} · ativo{" "}
                            {relativeTime(group.lastMessageAt)}
                          </p>
                        </div>
                        <PermissionGate
                          organizationId={organizationId}
                          category="settings"
                          level="manage"
                          fallback={
                            <Badge variant={group.monitored ? "success" : "default"}>
                              {group.monitored ? "Acompanhado" : "Fora"}
                            </Badge>
                          }
                        >
                          <button
                            type="button"
                            role="switch"
                            aria-checked={group.monitored}
                            aria-label={`Acompanhar ${group.subject}`}
                            onClick={() => void handleToggleMonitored(group)}
                            className={cn(
                              "relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                              group.monitored
                                ? "bg-brand-500"
                                : "bg-surface-overlay border border-border-strong"
                            )}
                          >
                            <span
                              className={cn(
                                "pointer-events-none h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                                group.monitored ? "translate-x-5" : "translate-x-1"
                              )}
                            />
                          </button>
                        </PermissionGate>
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {group.monitored && group.conversationId && (
                          <button
                            type="button"
                            onClick={() =>
                              navigate(`${TAB_ROUTES.inbox}?conversation=${group.conversationId}`)
                            }
                            className="inline-flex items-center gap-1 rounded-full border border-border-strong px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-brand-500 hover:text-brand-400"
                          >
                            <MessageSquare size={11} />
                            Abrir no inbox
                          </button>
                        )}
                        <PermissionGate
                          organizationId={organizationId}
                          category="settings"
                          level="manage"
                        >
                          <button
                            type="button"
                            onClick={() => setAiGroup(group)}
                            className="inline-flex items-center gap-1 rounded-full border border-border-strong px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-brand-500 hover:text-brand-400"
                          >
                            <Sparkles size={11} />
                            IA{group.ai?.mode === "mention" ? " · mencionada" : ""}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmLeave(group)}
                            className="inline-flex items-center gap-1 rounded-full border border-border-strong px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-semantic-error hover:text-semantic-error"
                          >
                            <LogOut size={11} />
                            Sair
                          </button>
                        </PermissionGate>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {/* Aceite de risco (D12) */}
      <Modal open={ackOpen} onClose={() => setAckOpen(false)} title="Ligar grupos neste número">
        <div className="space-y-4">
          <div className="flex gap-3 rounded-lg border border-semantic-warning/40 bg-semantic-warning/5 p-3">
            <AlertTriangle size={20} className="mt-0.5 shrink-0 text-semantic-warning" />
            <div className="space-y-2 text-sm text-text-secondary leading-relaxed">
              <p>
                Este número fala com o WhatsApp por uma <strong>API não-oficial</strong>.
                Ela já carrega risco de banimento; grupos <strong>aumentam a exposição</strong>,
                porque o volume e a variedade de eventos crescem muito.
              </p>
              <p>
                Os membros de um grupo são <strong>terceiros</strong> — gente que
                nunca falou com a sua empresa. Nomes e telefones deles vão passar
                a aparecer no CRM. Trate isso como dado pessoal (LGPD) e só
                acompanhe salas em que a sua empresa tem base legal para estar.
              </p>
              <p>
                A Meta pode banir a conta a qualquer momento, sem aviso e sem
                recurso. Não use um número que você não pode perder.
              </p>
            </div>
          </div>
          <p className="text-xs text-text-muted">
            Ligar registra o aceite na auditoria com o seu nome. Depois disso, o
            CRM só LISTA os grupos — acompanhar cada sala continua sendo uma
            escolha separada.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAckOpen(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button onClick={() => void handleAccept()} disabled={busy}>
              {busy ? <Spinner size="sm" /> : null}
              Entendo o risco — ligar grupos
            </Button>
          </div>
        </div>
      </Modal>

      {/* Entrar em grupo por link de convite */}
      <Modal
        open={joinOpen}
        onClose={() => {
          setJoinOpen(false);
          setJoinPreview(null);
        }}
        title="Entrar em grupo por link"
      >
        <div className="space-y-3">
          <Input
            label="Link de convite"
            placeholder="https://chat.whatsapp.com/…"
            value={joinLink}
            onChange={(e) => {
              setJoinLink(e.target.value);
              setJoinPreview(null);
            }}
          />
          {joinPreview && (
            <div className="rounded-lg border border-border bg-surface-sunken p-3">
              <p className="text-sm font-medium text-text-primary">{joinPreview.subject}</p>
              <p className="mt-0.5 text-xs text-text-muted tabular-nums">
                {joinPreview.participantsCount} membro
                {joinPreview.participantsCount === 1 ? "" : "s"}
              </p>
              <p className="mt-2 text-xs text-text-muted">
                Entrar coloca o número nesta sala de verdade. O grupo nasce{" "}
                <strong>sem acompanhamento</strong>: nada é ingerido até você
                marcar "Acompanhar".
              </p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setJoinOpen(false);
                setJoinPreview(null);
              }}
              disabled={joinBusy}
            >
              Cancelar
            </Button>
            {joinPreview ? (
              <Button onClick={() => void handleConfirmJoin()} disabled={joinBusy}>
                {joinBusy ? <Spinner size="sm" /> : null}
                Entrar no grupo
              </Button>
            ) : (
              <Button
                onClick={() => void handlePreviewJoin()}
                disabled={joinBusy || joinLink.trim().length === 0}
              >
                {joinBusy ? <Spinner size="sm" /> : null}
                Ver o grupo
              </Button>
            )}
          </div>
        </div>
      </Modal>

      {aiGroup && (
        <GroupAiPolicyModal open group={aiGroup} onClose={() => setAiGroup(null)} />
      )}

      <ConfirmDialog
        open={confirmDisable}
        onClose={() => setConfirmDisable(false)}
        onConfirm={() => {
          setConfirmDisable(false);
          void applyToggleEnabled();
        }}
        title="Desligar os grupos deste número?"
        description={`Os ${monitoredCount} grupo(s) acompanhados serão desmarcados e as conversas deles saem da caixa de entrada. Religar o interruptor NÃO restaura as escolhas — você terá de marcar "Acompanhar" grupo a grupo de novo. As mensagens já recebidas continuam guardadas.`}
        confirmLabel="Desligar mesmo assim"
        variant="danger"
      />

      <ConfirmDialog
        open={confirmLeave !== null}
        onClose={() => setConfirmLeave(null)}
        onConfirm={() => {
          const target = confirmLeave;
          setConfirmLeave(null);
          if (target) void handleLeave(target);
        }}
        title={confirmLeave ? `Sair de '${confirmLeave.subject}'?` : "Sair do grupo?"}
        description="O número sai da sala no WhatsApp — os membros veem a saída. Voltar exige um convite novo. A ação é registrada na auditoria."
        confirmLabel="Sair do grupo"
        variant="danger"
      />
    </div>
  );
}
