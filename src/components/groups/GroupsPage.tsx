import { useMemo, useState } from "react";
import { useNavigate, useOutletContext, useSearchParams } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import {
  EyeOff,
  HardDrive,
  MessageSquare,
  Send,
  Settings as SettingsIcon,
  ShieldCheck,
  Timer,
  Users,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { usePermissions } from "@/hooks/usePermissions";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { GroupMembersPanel } from "@/components/inbox/GroupMembersPanel";
import { ContactDetailPanel } from "@/components/ContactDetailPanel";
import { GroupPostsTab } from "@/components/groups/posts/GroupPostsTab";
import { GroupMediaPolicyModal } from "@/components/groups/GroupMediaPolicyModal";
import type { GroupChatDoc } from "@/components/inbox/types";
import { TAB_ROUTES } from "@/lib/routes";
import { activityLabel, relativeTime } from "@/lib/groupDisplay";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import {
  hasGroupMediaOverride,
  normalizeGroupMedia,
  normalizeGroupMediaOverrides,
  summarizeGroupMedia,
} from "@/lib/groupMedia";

type GroupsTab = "groups" | "posts";

const TABS: { id: GroupsTab; label: string }[] = [
  { id: "groups", label: "Grupos" },
  { id: "posts", label: "Publicações" },
];

/**
 * `/app/grupos` — a visão da operação de grupos, acima de qualquer conversa.
 *
 * A tela de Canais responde "quais salas este NÚMERO conhece?"; esta responde
 * "o que a empresa está acompanhando?", somando os números bridge. Ligar,
 * entrar e sair continuam no card do número; acompanhar/deixar de acompanhar
 * uma sala JÁ CONHECIDA também pode ser feito aqui — é a mesma escolha por
 * grupo (D4) do painel de canais, só que ao lado da lista do que já está
 * acompanhado, para quem esqueceu o passo lá.
 */
export function GroupsPage() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const navigate = useNavigate();
  const { can, isLoading } = usePermissions(organizationId);
  const canView = can("inbox", "view_own");
  const canManageCampaigns = can("campaigns", "manage");
  const canManageSettings = can("settings", "manage");
  const setMonitored = useMutation(api.groupChats.setMonitored);

  /**
   * Porta de entrada da F5: o wizard de campanha abre já preenchido.
   * `group_members` = uma mensagem privada por participante; a seleção do
   * painel de membros vira público `manual` com o grupo de origem marcado.
   */
  const dispatchToMembers = (groupChatId: Id<"groupChats">) =>
    navigate(`${TAB_ROUTES.campaigns}?novo=1&source=group_members&groupChatId=${groupChatId}`);
  const dispatchToSelected = (phones: string[], groupChatId: Id<"groupChats">) =>
    navigate(
      `${TAB_ROUTES.campaigns}?novo=1&source=manual&sourceGroupChatId=${groupChatId}&phones=${encodeURIComponent(
        phones.join(",")
      )}`
    );

  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("aba");
  // `?post=<id>` (deep-link da notificação `group_post_pending`) manda direto
  // para a aba Publicações, mesmo sem `?aba=posts` na URL.
  const activeTab: GroupsTab =
    tabParam === "posts" || searchParams.get("post") ? "posts" : "groups";
  const [membersFor, setMembersFor] = useState<Id<"groupChats"> | null>(null);
  const [memberContactId, setMemberContactId] = useState<Id<"contacts"> | null>(null);
  // Segue o mesmo padrão do painel de canais: um id em voo trava só a LINHA
  // dele, e o "parar de acompanhar" pede confirmação por ser mais destrutivo
  // (some da Caixa de Entrada e apaga a lista de membros).
  const [followingId, setFollowingId] = useState<string | null>(null);
  const [unfollowTarget, setUnfollowTarget] = useState<GroupChatDoc | null>(null);
  const [mediaTarget, setMediaTarget] = useState<GroupChatDoc | null>(null);

  const groups = useQuery(
    api.groupChats.listGroups,
    canView ? { organizationId } : "skip"
  ) as GroupChatDoc[] | undefined;
  const channels = useQuery(
    api.groupChats.listChannelGroupSettings,
    canView ? { organizationId } : "skip"
  );

  const channelName = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of channels ?? []) map.set(c.channelConfigId, c.displayName);
    return map;
  }, [channels]);

  const monitored = useMemo(
    () =>
      (groups ?? []).filter(
        (g) => g.monitored && g.removedAt === undefined && g.leftAt === undefined
      ),
    [groups]
  );
  // Salas que o CRM conhece mas ninguém marcou "Acompanhar" — removida/saída
  // FICA de fora (não é escolha do usuário, é o número que não está mais lá).
  const unmonitored = useMemo(
    () =>
      (groups ?? []).filter(
        (g) => !g.monitored && g.removedAt === undefined && g.leftAt === undefined
      ),
    [groups]
  );
  const anyChannelEnabled = (channels ?? []).some((c) => c.groupsEnabled);

  const handleFollow = async (group: GroupChatDoc) => {
    setFollowingId(group._id);
    try {
      await setMonitored({ groupChatId: group._id as Id<"groupChats">, monitored: true });
      toast.success(`Acompanhando '${group.subject}'`);
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao acompanhar o grupo"));
    } finally {
      setFollowingId(null);
    }
  };

  const handleUnfollow = async (group: GroupChatDoc) => {
    try {
      await setMonitored({ groupChatId: group._id as Id<"groupChats">, monitored: false });
      toast.success(`Parou de acompanhar '${group.subject}'`);
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao parar de acompanhar"));
    }
  };

  const setTab = (tab: GroupsTab) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (tab === "groups") {
          next.delete("aba");
          // Sem isso o `?post=` residual reabriria a aba Publicações na hora.
          next.delete("post");
        } else {
          next.set("aba", tab);
        }
        return next;
      },
      { replace: true }
    );
  };

  const goToChannels = () => navigate(`${TAB_ROUTES.settings}?secao=channels`);

  if (isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }
  if (!canView) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Users}
          title="Sem acesso"
          description="Você não tem permissão para ver os grupos. Peça a um administrador."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto flex items-center gap-2">
          <Users size={22} className="text-brand-500" />
          <h1 className="text-xl font-semibold text-text-primary">Grupos</h1>
        </div>
        <Button variant="secondary" onClick={goToChannels}>
          <SettingsIcon size={16} />
          Gerenciar nos canais
        </Button>
      </div>

      <div className="flex gap-4 border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setTab(tab.id)}
            className={cn(
              "border-b-2 px-1 py-3 text-sm font-medium transition-colors",
              activeTab === tab.id
                ? "border-brand-500 text-brand-500"
                : "border-transparent text-text-secondary hover:text-text-primary"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "posts" ? (
        <GroupPostsTab organizationId={organizationId} />
      ) : groups === undefined ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : monitored.length === 0 && unmonitored.length === 0 ? (
        <EmptyState
          icon={Users}
          title={anyChannelEnabled ? "Nenhum grupo neste número" : "Grupos desligados nos seus números"}
          description={
            anyChannelEnabled
              ? "Sincronize a lista de salas no card do número em Configurações → Canais."
              : "Ligue os grupos num número bridge em Configurações → Canais para o CRM listar as salas."
          }
          action={{ label: "Abrir Canais", onClick: goToChannels }}
        />
      ) : monitored.length === 0 ? (
        // Já sabemos de sala — só falta escolher. Fica no lugar do estado
        // vazio (não faz sentido dizer "nenhum grupo" com N salas listadas
        // logo abaixo).
        <div className="space-y-4">
          <div>
            <h2 className="text-base font-medium text-text-primary">
              Escolha os grupos para acompanhar
            </h2>
            <p className="mt-1 max-w-xl text-sm text-text-secondary">
              Só os grupos que você acompanha aparecem na Caixa de Entrada, podem
              receber publicações programadas e ter a IA ligada. Os demais ficam só
              listados — nada é lido nem guardado.
            </p>
          </div>
          <UnmonitoredGroupsSection
            groups={unmonitored}
            channelName={channelName}
            canManage={canManageSettings}
            followingId={followingId}
            onFollow={(group) => void handleFollow(group)}
          />
        </div>
      ) : (
        <>
          {/* Mobile: cards */}
          <ul className="space-y-2 md:hidden">
            {monitored.map((group) => (
              <li
                key={group._id}
                className="space-y-2 rounded-card border border-border bg-surface-raised p-3.5"
              >
                <GroupTitle group={group} />
                <p className="text-xs text-text-muted tabular-nums">
                  {channelName.get(group.channelConfigId) ?? "Número bridge"} ·{" "}
                  {group.participantsCount} membro{group.participantsCount === 1 ? "" : "s"} ·{" "}
                  {activityLabel(group.lastMessageAt)}
                </p>
                <GroupMediaSummary group={group} />
                <GroupActions
                  group={group}
                  onOpenInbox={() =>
                    navigate(`${TAB_ROUTES.inbox}?conversation=${group.conversationId}`)
                  }
                  onMembers={() => setMembersFor(group._id as Id<"groupChats">)}
                  {...(canManageCampaigns
                    ? { onDispatchMembers: () => dispatchToMembers(group._id as Id<"groupChats">) }
                    : {})}
                  {...(canManageSettings ? { onUnfollow: () => setUnfollowTarget(group) } : {})}
                  onMedia={() => setMediaTarget(group)}
                />
              </li>
            ))}
          </ul>

          {/* Desktop: tabela */}
          <div className="hidden overflow-x-auto rounded-card border border-border md:block">
            <table className="w-full text-sm">
              <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Grupo</th>
                  <th className="px-3 py-2 font-medium">Número</th>
                  <th className="px-3 py-2 font-medium">Membros</th>
                  <th className="px-3 py-2 font-medium">Última atividade</th>
                  <th className="px-3 py-2 font-medium text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {monitored.map((group) => (
                  <tr key={group._id} className="bg-surface-raised">
                    <td className="max-w-xs px-3 py-2.5">
                      <GroupTitle group={group} />
                      <GroupMediaSummary group={group} className="mt-1" />
                    </td>
                    <td className="px-3 py-2.5 text-text-secondary">
                      {channelName.get(group.channelConfigId) ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-text-secondary tabular-nums">
                      {group.participantsCount}
                    </td>
                    <td className="px-3 py-2.5 text-text-muted">
                      {relativeTime(group.lastMessageAt)}
                    </td>
                    <td className="px-3 py-2.5">
                      <GroupActions
                        align="end"
                        group={group}
                        onOpenInbox={() =>
                          navigate(`${TAB_ROUTES.inbox}?conversation=${group.conversationId}`)
                        }
                        onMembers={() => setMembersFor(group._id as Id<"groupChats">)}
                        {...(canManageCampaigns
                          ? { onDispatchMembers: () => dispatchToMembers(group._id as Id<"groupChats">) }
                          : {})}
                        {...(canManageSettings ? { onUnfollow: () => setUnfollowTarget(group) } : {})}
                        onMedia={() => setMediaTarget(group)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {unmonitored.length > 0 && (
            <UnmonitoredGroupsSection
              groups={unmonitored}
              channelName={channelName}
              canManage={canManageSettings}
              followingId={followingId}
              onFollow={(group) => void handleFollow(group)}
            />
          )}
        </>
      )}

      {mediaTarget && (
        <GroupMediaPolicyModal open group={mediaTarget} onClose={() => setMediaTarget(null)} />
      )}
      {membersFor && (
        <GroupMembersPanel
          open
          groupChatId={membersFor}
          organizationId={organizationId}
          onClose={() => setMembersFor(null)}
          onOpenContact={(contactId) => setMemberContactId(contactId)}
          {...(canManageCampaigns ? { onDispatchSelected: dispatchToSelected } : {})}
        />
      )}
      {/* Depois do painel de membros no DOM, para ficar por cima (v0.48). */}
      {memberContactId && (
        <ContactDetailPanel
          contactId={memberContactId}
          onClose={() => setMemberContactId(null)}
        />
      )}

      <ConfirmDialog
        open={unfollowTarget !== null}
        onClose={() => setUnfollowTarget(null)}
        onConfirm={() => {
          const target = unfollowTarget;
          setUnfollowTarget(null);
          if (target) void handleUnfollow(target);
        }}
        title={unfollowTarget ? `Parar de acompanhar '${unfollowTarget.subject}'?` : "Parar de acompanhar?"}
        description="A conversa do grupo sai da Caixa de Entrada e a lista de membros é apagada do CRM. As mensagens já recebidas continuam guardadas. Publicações programadas para este grupo param de funcionar."
        confirmLabel="Parar de acompanhar"
        variant="danger"
      />
    </div>
  );
}

function GroupTitle({ group }: { group: GroupChatDoc }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Users size={14} className="shrink-0 text-text-muted" aria-hidden />
      <span className="truncate font-medium text-text-primary">{group.subject}</span>
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
      {group.ai?.mode === "mention" && <Badge variant="brand">IA quando mencionada</Badge>}
    </div>
  );
}

/**
 * "Mídia: só com a gente" — o modo EFETIVO da sala (já resolvido contra o
 * número), com um selo quando a sala tem regra própria.
 */
function GroupMediaSummary({ group, className }: { group: GroupChatDoc; className?: string }) {
  const custom = hasGroupMediaOverride(normalizeGroupMediaOverrides(group.mediaPolicy));
  return (
    <p className={cn("flex items-center gap-1 text-xs text-text-muted", className)}>
      <HardDrive size={11} className="shrink-0" aria-hidden />
      <span className="truncate">{summarizeGroupMedia(normalizeGroupMedia(group.effectiveMedia))}</span>
      {custom && <span className="shrink-0 text-brand-400">· regra da sala</span>}
    </p>
  );
}

function GroupActions({
  group,
  onOpenInbox,
  onMembers,
  onDispatchMembers,
  onUnfollow,
  onMedia,
  align,
}: {
  group: GroupChatDoc;
  onOpenInbox: () => void;
  onMembers: () => void;
  /** F5 — abre o wizard de campanha com este grupo já selecionado. */
  onDispatchMembers?: () => void;
  /** Só passado com `settings:manage` — abre a confirmação de deixar de acompanhar. */
  onUnfollow?: () => void;
  /** Abre a política de mídia da sala (quem não gerencia vê só leitura). */
  onMedia: () => void;
  align?: "end";
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", align === "end" && "justify-end")}>
      <button
        type="button"
        onClick={onOpenInbox}
        disabled={!group.conversationId}
        className="inline-flex items-center gap-1 rounded-full border border-border-strong px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-brand-500 hover:text-brand-400 disabled:opacity-50"
      >
        <MessageSquare size={11} />
        Abrir no inbox
      </button>
      <button
        type="button"
        onClick={onMembers}
        className="inline-flex items-center gap-1 rounded-full border border-border-strong px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-brand-500 hover:text-brand-400"
      >
        <Users size={11} />
        Membros
      </button>
      <button
        type="button"
        onClick={onMedia}
        className="inline-flex items-center gap-1 rounded-full border border-border-strong px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-brand-500 hover:text-brand-400"
      >
        <HardDrive size={11} />
        Mídia
      </button>
      <button
        type="button"
        onClick={onDispatchMembers}
        disabled={!onDispatchMembers}
        title={
          onDispatchMembers
            ? "Cria uma campanha de mensagem privada para os membros deste grupo"
            : "Precisa de permissão para gerenciar campanhas"
        }
        className="inline-flex items-center gap-1 rounded-full border border-border-strong px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-brand-500 hover:text-brand-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Send size={11} />
        Disparar 1 a 1 para os membros
      </button>
      {onUnfollow && (
        <button
          type="button"
          onClick={onUnfollow}
          className="inline-flex items-center gap-1 rounded-full border border-border-strong px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-semantic-error hover:text-semantic-error"
        >
          <EyeOff size={11} />
          Parar de acompanhar
        </button>
      )}
    </div>
  );
}

/**
 * Salas que o CRM já conhece neste número mas ninguém marcou "Acompanhar"
 * (D4 — opt-in por grupo). Some sozinha quando não sobra nenhuma.
 */
function UnmonitoredGroupsSection({
  groups,
  channelName,
  canManage,
  followingId,
  onFollow,
}: {
  groups: GroupChatDoc[];
  channelName: Map<string, string>;
  canManage: boolean;
  followingId: string | null;
  onFollow: (group: GroupChatDoc) => void;
}) {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium text-text-secondary">Outras salas deste número</h2>
      <ul className="space-y-2">
        {groups.map((group) => (
          <li
            key={group._id}
            className="flex flex-col gap-2 rounded-card border border-border-subtle bg-surface-sunken p-3 md:flex-row md:items-center md:justify-between"
          >
            <div className="min-w-0">
              <GroupTitle group={group} />
              <p className="mt-0.5 text-xs text-text-muted tabular-nums">
                {channelName.get(group.channelConfigId) ?? "Número bridge"} ·{" "}
                {group.participantsCount} membro{group.participantsCount === 1 ? "" : "s"}
              </p>
            </div>
            {canManage ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={followingId === group._id}
                onClick={() => onFollow(group)}
                className="shrink-0 self-start md:self-auto"
              >
                {followingId === group._id ? <Spinner size="sm" /> : null}
                Acompanhar
              </Button>
            ) : (
              <span className="shrink-0 text-xs text-text-muted">Peça a um administrador</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
