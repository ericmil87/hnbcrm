/**
 * Aba "Publicações" de `/app/grupos` (F3).
 *
 * "Todo dia às 12h o Guardião posta no grupo XYZ." Aqui a equipe vê o que está
 * programado, aprova o texto que a IA escreveu para o próximo horário e abre o
 * histórico de cada disparo.
 *
 * Deep-link `?post=<id>` abre o detalhe — é o destino da notificação
 * `group_post_pending`, então cair aqui já mostra o card de aprovação.
 *
 * RBAC (categoria `campaigns`): `view` lista e abre, `manage` cria/edita/pausa
 * e aprova, `full` ativa, encerra, exclui e envia fora da agenda.
 */
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQuery } from "convex/react";
import { Bot, CalendarClock, Library, Plus, Users } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Spinner } from "@/components/ui/Spinner";
import { usePermissions } from "@/hooks/usePermissions";
import { TAB_ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";
import type { GroupChatDoc } from "@/components/inbox/types";
import { GroupPostDetail } from "./GroupPostDetail";
import { GroupPostWizard } from "./GroupPostWizard";
import {
  POST_STATUS_LABELS,
  POST_STATUS_VARIANT,
  contentSummary,
  formatShortDateTime,
  untilText,
} from "./postUtils";
import type { ChannelGroupSettings, GroupPostListItem, GroupPostStatus } from "./types";

type StatusFilter = GroupPostStatus | "all";
type ChannelFilter = Id<"channelConfigs"> | "all";

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "Todas" },
  { id: "active", label: "Ativas" },
  { id: "draft", label: "Rascunhos" },
  { id: "paused", label: "Pausadas" },
  { id: "ended", label: "Encerradas" },
];

export function GroupPostsTab({ organizationId }: { organizationId: Id<"organizations"> }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { can, isLoading } = usePermissions(organizationId);
  const canView = can("campaigns", "view");
  const canManage = can("campaigns", "manage");

  const [status, setStatus] = useState<StatusFilter>("all");
  const [channelConfigId, setChannelConfigId] = useState<ChannelFilter>("all");
  /** `null` = fechado; `"new"` = criação; id = edição. */
  const [wizard, setWizard] = useState<Id<"groupPosts"> | "new" | null>(null);
  const [now] = useState(() => Date.now());

  const posts = useQuery(
    api.groupPosts.list,
    canView
      ? {
          organizationId,
          ...(status === "all" ? {} : { status }),
          ...(channelConfigId === "all" ? {} : { channelConfigId }),
        }
      : "skip"
  ) as GroupPostListItem[] | undefined;
  const groups = useQuery(api.groupChats.listGroups, canView ? { organizationId } : "skip") as
    | GroupChatDoc[]
    | undefined;
  const channels = useQuery(
    api.groupChats.listChannelGroupSettings,
    canView ? { organizationId } : "skip"
  ) as ChannelGroupSettings[] | undefined;

  const groupChannels = useMemo(
    () => (channels ?? []).filter((c) => c.groupsEnabled === true),
    [channels]
  );

  const monitoredCount = useMemo(
    () =>
      (groups ?? []).filter(
        (g) => g.monitored && g.removedAt === undefined && g.leftAt === undefined && g.conversationId
      ).length,
    [groups]
  );

  const openPostId = searchParams.get("post") as Id<"groupPosts"> | null;

  const setOpenPost = (id: Id<"groupPosts"> | null) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("aba", "posts");
        if (id) next.set("post", id);
        else next.delete("post");
        return next;
      },
      { replace: true }
    );

  const goToGroupsTab = () =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("aba");
        next.delete("post");
        return next;
      },
      { replace: true }
    );

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!canView) {
    return (
      <EmptyState
        icon={CalendarClock}
        title="Sem acesso às publicações"
        description="Ver e programar publicações em grupos exige permissão na categoria Campanhas. Peça a um administrador."
      />
    );
  }

  const pendingCount = (posts ?? []).filter((p) => p.pendingApproval).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => setStatus(filter.id)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                status === filter.id
                  ? "border-brand-500 bg-brand-500/15 text-brand-400"
                  : "border-border-strong bg-surface-raised text-text-secondary hover:text-text-primary"
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
        {groupChannels.length >= 2 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setChannelConfigId("all")}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                channelConfigId === "all"
                  ? "border-brand-500 bg-brand-500/15 text-brand-400"
                  : "border-border-strong bg-surface-raised text-text-secondary hover:text-text-primary"
              )}
            >
              Todos os números
            </button>
            {groupChannels.map((channel) => (
              <button
                key={channel.channelConfigId}
                type="button"
                onClick={() => setChannelConfigId(channel.channelConfigId)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  channelConfigId === channel.channelConfigId
                    ? "border-brand-500 bg-brand-500/15 text-brand-400"
                    : "border-border-strong bg-surface-raised text-text-secondary hover:text-text-primary"
                )}
              >
                {channel.displayName}
              </button>
            ))}
          </div>
        )}
        {canManage && (
          <Button
            size="sm"
            className="ml-auto"
            disabled={monitoredCount === 0}
            title={monitoredCount === 0 ? "Acompanhe um grupo antes de programar publicações" : undefined}
            onClick={() => setWizard("new")}
          >
            <Plus size={15} />
            Nova publicação
          </Button>
        )}
      </div>

      {pendingCount > 0 && (
        <p className="rounded-lg border border-semantic-warning/40 bg-semantic-warning/10 px-3 py-2 text-xs text-semantic-warning">
          {pendingCount} publicação(ões) com texto da IA esperando aprovação.
        </p>
      )}

      {posts === undefined ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : monitoredCount === 0 ? (
        <EmptyState
          icon={Users}
          title="Nenhum grupo acompanhado"
          description="Uma publicação programada precisa de pelo menos um grupo acompanhado. Acompanhe um grupo na aba Grupos, ou ligue os grupos do número em Configurações → Canais."
          action={{ label: "Ver grupos", onClick: goToGroupsTab }}
        />
      ) : posts.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title={status === "all" ? "Nenhuma publicação programada" : "Nada com esse status"}
          description={
            status === "all"
              ? "Programe mensagens que saem sozinhas nos grupos: textos prontos em sequência ou sorteados, ou a mensagem do dia escrita pela IA com aprovação antes de ir ao ar."
              : "Troque o filtro para ver as outras publicações."
          }
          action={
            canManage && status === "all"
              ? { label: "Nova publicação", onClick: () => setWizard("new") }
              : undefined
          }
        />
      ) : (
        <ul className="space-y-2">
          {posts.map((post) => (
            <li key={post._id}>
              <button
                type="button"
                onClick={() => setOpenPost(post._id)}
                className="w-full rounded-card border border-border bg-surface-raised p-3.5 text-left transition-colors hover:border-border-strong"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={POST_STATUS_VARIANT[post.status]}>
                    {POST_STATUS_LABELS[post.status]}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-medium text-text-primary">
                    {post.name}
                  </span>
                  {post.pendingApproval && (
                    <>
                      <Badge variant="warning">
                        <span className="inline-flex items-center gap-1">
                          <Bot size={10} /> aguardando aprovação
                        </span>
                      </Badge>
                      <span className="text-xs font-medium text-brand-400 underline">
                        Revisar texto
                      </span>
                    </>
                  )}
                </div>

                <p className="mt-1.5 text-xs text-text-secondary">{post.scheduleText}</p>

                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-muted">
                  <span className="inline-flex items-center gap-1">
                    <Users size={11} />
                    {post.targets.length} grupo{post.targets.length === 1 ? "" : "s"}
                    {post.targetNames.length > 0 ? `: ${post.targetNames.slice(0, 2).join(", ")}` : ""}
                    {post.targetNames.length > 2 ? ` +${post.targetNames.length - 2}` : ""}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    {post.content.kind === "ai" ? <Bot size={11} /> : <Library size={11} />}
                    {contentSummary(post.content)}
                  </span>
                </p>

                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
                  {post.status === "active" && post.nextRunAt ? (
                    <span className="tabular-nums">
                      Próximo envio {formatShortDateTime(post.nextRunAt, post.schedule.timezone)} (
                      {untilText(post.nextRunAt, now)})
                    </span>
                  ) : post.status === "paused" && post.pausedReason ? (
                    <span className="text-semantic-warning">Pausada: {post.pausedReason}</span>
                  ) : null}
                  <span className="tabular-nums">
                    {post.stats.sent} enviada{post.stats.sent === 1 ? "" : "s"} ·{" "}
                    {post.stats.skipped} pulada{post.stats.skipped === 1 ? "" : "s"} ·{" "}
                    {post.stats.failed} falha{post.stats.failed === 1 ? "" : "s"}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/*
        O id vem CRU da URL: link truncado no e-mail/WhatsApp, ou publicação de
        outra org, fazem `groupPosts.get` lançar. Sem esta fronteira o
        ErrorBoundary do AuthLayout troca a página inteira por "Algo deu errado"
        — mesmo padrão do `?conversation=` do inbox e do `?lead=` do funil.
      */}
      {openPostId && (
        <ErrorBoundary key={openPostId} fallback={<></>}>
          <GroupPostDetail
            groupPostId={openPostId}
            organizationId={organizationId}
            onClose={() => setOpenPost(null)}
            onEdit={(id) => setWizard(id)}
          />
        </ErrorBoundary>
      )}

      {wizard && (
        <GroupPostWizard
          organizationId={organizationId}
          groupPostId={wizard === "new" ? null : wizard}
          onClose={() => setWizard(null)}
          onSaved={(id) => {
            setWizard(null);
            setOpenPost(id);
          }}
          onGoToGroups={() => {
            setWizard(null);
            goToGroupsTab();
          }}
          onOpenAiSettings={() => navigate(`${TAB_ROUTES.settings}?secao=ai`)}
        />
      )}
    </div>
  );
}
