/**
 * Detalhe de uma publicação programada: o que ela vai postar, onde, quando, o
 * que já postou — e as decisões humanas (aprovar o texto da IA, pausar,
 * encerrar, testar, enviar agora).
 *
 * Duas coisas separadas de propósito: "Testar agora" é uma PRÉVIA (não escreve
 * nada, gate `campaigns:manage`) e "Enviar agora de verdade" manda a mensagem
 * para o grupo (gate `campaigns:full` + confirmação digitada).
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarClock,
  Check,
  CircleSlash,
  Eye,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Send,
  Square,
  Trash2,
  Users,
  XCircle,
} from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { SlideOver } from "@/components/ui/SlideOver";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { WhatsAppPreview } from "@/components/campaigns/WhatsAppPreview";
import { usePermissions } from "@/hooks/usePermissions";
import { mutationErrorMessage } from "@/lib/errors";
import { TAB_ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { SendNowDialog } from "./SendNowDialog";
import {
  POST_STATUS_LABELS,
  POST_STATUS_VARIANT,
  contentSummary,
  formatDateTime,
  formatShortDateTime,
  previewVars,
  untilText,
} from "./postUtils";
import type { GroupPostDetailDoc, GroupPostHistoryEntry, SendNowResult } from "./types";

interface GroupPostDetailProps {
  groupPostId: Id<"groupPosts">;
  organizationId: Id<"organizations">;
  onClose: () => void;
  onEdit: (groupPostId: Id<"groupPosts">) => void;
}

export function GroupPostDetail({ groupPostId, organizationId, onClose, onEdit }: GroupPostDetailProps) {
  const navigate = useNavigate();
  const { can } = usePermissions(organizationId);
  const canManage = can("campaigns", "manage");
  const canFull = can("campaigns", "full");

  const post = useQuery(api.groupPosts.get, { groupPostId }) as GroupPostDetailDoc | null | undefined;
  const history = useQuery(api.groupPosts.getHistory, { groupPostId }) as
    | GroupPostHistoryEntry[]
    | undefined;

  const activate = useMutation(api.groupPosts.activate);
  const pause = useMutation(api.groupPosts.pause);
  const end = useMutation(api.groupPosts.end);
  const remove = useMutation(api.groupPosts.remove);
  const approvePending = useMutation(api.groupPosts.approvePending);
  const rejectPending = useMutation(api.groupPosts.rejectPending);
  const sendNow = useAction(api.groupPosts.sendNow);

  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sendDialog, setSendDialog] = useState(false);
  const [preview, setPreview] = useState<SendNowResult | null>(null);
  const [now] = useState(() => Date.now());

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      toast.success(label);
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível concluir a ação"));
    } finally {
      setBusy(false);
    }
  };

  if (post === undefined) {
    return (
      <SlideOver open onClose={onClose} title="Publicação" className="md:w-[720px] lg:w-[900px]">
        <div className="flex h-64 items-center justify-center">
          <Spinner size="lg" />
        </div>
      </SlideOver>
    );
  }
  if (post === null) {
    return (
      <SlideOver open onClose={onClose} title="Publicação" className="md:w-[720px] lg:w-[900px]">
        <div className="p-6 text-sm text-text-secondary">
          Publicação não encontrada — pode ter sido excluída.
        </div>
      </SlideOver>
    );
  }

  const channelDown =
    post.channel === null ||
    post.channel.status !== "active" ||
    !post.channel.groupsEnabled ||
    (post.channel.sessionState !== undefined && post.channel.sessionState !== "connected");
  const lostTargets = post.targets.filter((t) => t.left || !t.monitored);
  const sampleVars = previewVars(post.targets[0]?.subject ?? "Seu grupo", now, post.schedule.timezone);

  return (
    <SlideOver
      open
      onClose={onClose}
      title={post.name}
      className="md:w-[720px] lg:w-[900px]"
      headerActions={
        post.status !== "ended" && canManage ? (
          <button
            type="button"
            onClick={() => onEdit(post._id)}
            aria-label="Editar publicação"
            title="Editar"
            className="rounded-full p-1.5 text-text-muted transition-colors hover:bg-surface-overlay hover:text-text-primary"
          >
            <Pencil size={18} />
          </button>
        ) : undefined
      }
    >
      <div className="space-y-5 p-4 md:p-6">
        {/* Estado */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={POST_STATUS_VARIANT[post.status]}>{POST_STATUS_LABELS[post.status]}</Badge>
          {post.pending?.status === "pendingApproval" && <Badge variant="warning">aguardando aprovação</Badge>}
          <span className="text-xs text-text-muted">{contentSummary(post.content)}</span>
        </div>

        {post.status === "paused" && post.pausedReason && (
          <Banner tone="warning">Pausada: {post.pausedReason}</Banner>
        )}
        {channelDown && post.status !== "ended" && (
          <Banner tone="error">
            O número {post.channel?.displayName ?? "do canal"} não está pronto para publicar
            {post.channel ? ` (sessão: ${post.channel.sessionState ?? "desconhecida"}${post.channel.groupsEnabled ? "" : ", grupos desligados"})` : ""}.
            Os disparos vão falhar até resolver isso em Configurações → Canais.
          </Banner>
        )}
        {lostTargets.length > 0 && (
          <Banner tone="warning">
            {lostTargets.length} destino(s) fora do ar:{" "}
            {lostTargets.map((t) => t.subject).join(", ")}. O worker pula quem saiu ou deixou de ser
            acompanhado.
          </Banner>
        )}

        {/* Pendente */}
        <PendingApprovalCard
          post={post}
          canManage={canManage}
          busy={busy}
          onApprove={(editedText) =>
            void run("Texto aprovado", () =>
              approvePending({ groupPostId: post._id, ...(editedText ? { editedText } : {}) })
            )
          }
          onReject={(reason) =>
            void run("Texto rejeitado", () =>
              rejectPending({ groupPostId: post._id, ...(reason ? { reason } : {}) })
            )
          }
        />

        {/* Resumo */}
        <section className="rounded-card border border-border bg-surface-raised p-3.5">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-text-primary">
            <CalendarClock size={15} className="text-brand-500" />
            Agenda
          </h3>
          <dl className="space-y-1.5 text-xs">
            <Row label="Quando" value={post.scheduleText} />
            <Row
              label="Próximo envio"
              value={
                post.status === "active" && post.nextRunAt
                  ? `${formatDateTime(post.nextRunAt, post.schedule.timezone)} (${untilText(post.nextRunAt, now)})`
                  : post.status === "active"
                    ? "sem horário futuro"
                    : "—"
              }
            />
            {post.schedule.startAt !== undefined && (
              <Row label="Começa em" value={formatDateTime(post.schedule.startAt, post.schedule.timezone)} />
            )}
            {post.schedule.endAt !== undefined && (
              <Row label="Termina em" value={formatDateTime(post.schedule.endAt, post.schedule.timezone)} />
            )}
            {(post.schedule.jitterMinutes ?? 0) > 0 && (
              <Row label="Variação" value={`até ${post.schedule.jitterMinutes} min depois do horário`} />
            )}
            <Row label="Número" value={post.channel?.displayName ?? "canal removido"} />
          </dl>
        </section>

        {/* Destinos */}
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-text-primary">
            <Users size={15} className="text-brand-500" />
            Destinos ({post.targets.length})
          </h3>
          <ul className="divide-y divide-border rounded-card border border-border bg-surface-raised">
            {post.targets.map((target) => (
              <li key={target.groupChatId} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{target.subject}</span>
                {target.left && <Badge variant="error">saiu do grupo</Badge>}
                {!target.left && !target.monitored && <Badge variant="warning">não acompanhado</Badge>}
                {target.conversationId && (
                  <button
                    type="button"
                    onClick={() => navigate(`${TAB_ROUTES.inbox}?conversation=${target.conversationId}`)}
                    className="inline-flex items-center gap-1 rounded-full border border-border-strong px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-brand-500 hover:text-brand-400"
                  >
                    <MessageSquare size={11} />
                    Abrir conversa
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        {/* Números */}
        <section className="grid grid-cols-3 gap-2">
          <Stat label="Disparos" value={post.stats.sent} />
          <Stat label="Pulados" value={post.stats.skipped} />
          <Stat label="Falhas" value={post.stats.failed} />
        </section>
        {post.stats.lastSentAt !== undefined && (
          <p className="-mt-3 text-xs text-text-muted">
            Último envio: {formatDateTime(post.stats.lastSentAt, post.schedule.timezone)}
          </p>
        )}
        {post.stats.lastError && (
          <p className="-mt-3 text-xs text-semantic-error">Último erro: {post.stats.lastError}</p>
        )}

        {/* Ações */}
        <section className="flex flex-wrap gap-2 border-t border-border pt-4">
          {(post.status === "draft" || post.status === "paused") && (
            <Button
              size="sm"
              disabled={busy || !canFull}
              title={canFull ? undefined : "Requer permissão total em campanhas"}
              onClick={() => void run("Publicação ativada", () => activate({ groupPostId: post._id }))}
            >
              <Play size={15} />
              {post.status === "paused" ? "Retomar" : "Ativar"}
            </Button>
          )}
          {post.status === "active" && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !canManage}
              onClick={() => void run("Publicação pausada", () => pause({ groupPostId: post._id }))}
            >
              <Pause size={15} />
              Pausar
            </Button>
          )}
          {post.status !== "ended" && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !canFull}
              title={canFull ? undefined : "Requer permissão total em campanhas"}
              onClick={() => setConfirmEnd(true)}
            >
              <Square size={15} />
              Encerrar
            </Button>
          )}
          {post.status !== "ended" && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !canManage}
              onClick={() =>
                void run("Prévia gerada", async () => {
                  const result = (await sendNow({ groupPostId: post._id, dryRun: true })) as SendNowResult;
                  setPreview(result);
                })
              }
            >
              <Eye size={15} />
              Testar agora
            </Button>
          )}
          {post.status !== "ended" && canFull && (
            <Button variant="danger" size="sm" disabled={busy} onClick={() => setSendDialog(true)}>
              <Send size={15} />
              Enviar agora de verdade
            </Button>
          )}
          {(post.status === "draft" || post.status === "ended") && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !canFull}
              title={canFull ? undefined : "Requer permissão total em campanhas"}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={15} />
              Excluir
            </Button>
          )}
        </section>

        {/* Prévia do teste */}
        {preview && (
          <section className="rounded-card border border-border bg-surface-raised p-3.5">
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-sm font-medium text-text-primary">Prévia — nada foi enviado</h3>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="ml-auto text-xs text-text-muted hover:text-text-primary"
              >
                fechar
              </button>
            </div>
            <div className="space-y-3">
              {preview.previews.map((item) => (
                <div key={item.groupChatId}>
                  <p className="mb-1 text-xs text-text-muted">{item.subject}</p>
                  <WhatsAppPreview text={item.text} vars={sampleVars} compact />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Histórico */}
        <section>
          <h3 className="mb-2 text-sm font-medium text-text-primary">Histórico</h3>
          {history === undefined ? (
            <p className="text-sm text-text-muted">Carregando…</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-text-muted">Nenhum disparo ainda.</p>
          ) : (
            <ul className="space-y-2">
              {history.map((entry, i) => (
                <li
                  key={`${entry.at}-${i}`}
                  className="rounded-card border border-border bg-surface-raised p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <HistoryIcon kind={entry.kind} />
                    <span className="text-xs font-medium text-text-primary">
                      {entry.kind === "sent" ? "Publicado" : entry.kind === "skipped" ? "Pulado" : "Falhou"}
                    </span>
                    <span className="text-xs text-text-muted tabular-nums">
                      {formatShortDateTime(entry.at, post.schedule.timezone)}
                    </span>
                  </div>
                  {entry.detail && (
                    <p className="mt-1 line-clamp-3 text-xs text-text-secondary">{entry.detail}</p>
                  )}
                  {entry.sends.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {entry.sends.map((send, j) => (
                        <button
                          key={`${send.groupChatId}-${j}`}
                          type="button"
                          disabled={!send.conversationId}
                          onClick={() =>
                            send.conversationId &&
                            navigate(`${TAB_ROUTES.inbox}?conversation=${send.conversationId}`)
                          }
                          title={send.error ?? "Abrir no inbox"}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                            send.error
                              ? "border-semantic-error/50 text-semantic-error"
                              : "border-border-strong text-text-secondary hover:border-brand-500 hover:text-brand-400",
                            !send.conversationId && "cursor-default opacity-70"
                          )}
                        >
                          {send.error ? <XCircle size={10} /> : <MessageSquare size={10} />}
                          {send.subject}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={confirmEnd}
        variant="danger"
        title="Encerrar publicação"
        description="Encerrar é definitivo: a publicação para de disparar e não pode ser reativada — para voltar a publicar, crie outra."
        confirmLabel="Encerrar"
        onClose={() => setConfirmEnd(false)}
        onConfirm={() => {
          setConfirmEnd(false);
          void run("Publicação encerrada", () => end({ groupPostId: post._id }));
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        variant="danger"
        title="Excluir publicação"
        description="Apaga a publicação e todo o histórico de disparos dela. As mensagens já enviadas aos grupos continuam lá."
        confirmLabel="Excluir"
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void run("Publicação excluída", async () => {
            await remove({ groupPostId: post._id });
            onClose();
          });
        }}
      />
      <SendNowDialog
        open={sendDialog}
        busy={busy}
        targetNames={post.targets.filter((t) => !t.left && t.monitored).map((t) => t.subject)}
        onClose={() => setSendDialog(false)}
        onConfirm={() => {
          setSendDialog(false);
          void run("Mensagem enviada", async () => {
            const result = (await sendNow({ groupPostId: post._id })) as SendNowResult;
            setPreview(null);
            if (result.delivered === 0) throw new Error("Nenhum grupo recebeu a mensagem");
          });
        }}
      />
    </SlideOver>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-text-secondary">{value}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-card border border-border bg-surface-raised p-3 text-center">
      <p className="text-lg font-semibold tabular-nums text-text-primary">{value}</p>
      <p className="text-[11px] text-text-muted">{label}</p>
    </div>
  );
}

function HistoryIcon({ kind }: { kind: GroupPostHistoryEntry["kind"] }) {
  if (kind === "sent") return <Check size={13} className="text-semantic-success" />;
  if (kind === "skipped") return <CircleSlash size={13} className="text-semantic-warning" />;
  return <AlertTriangle size={13} className="text-semantic-error" />;
}

function Banner({ tone, children }: { tone: "warning" | "error"; children: React.ReactNode }) {
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
        tone === "error"
          ? "border-semantic-error/40 bg-semantic-error/10 text-semantic-error"
          : "border-semantic-warning/40 bg-semantic-warning/10 text-semantic-warning"
      )}
    >
      <AlertTriangle size={14} className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  );
}
