import { useMemo, useState } from "react";
import { useNavigate, useOutletContext, useSearchParams } from "react-router";
import { useQuery } from "convex/react";
import {
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
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { GroupMembersPanel } from "@/components/inbox/GroupMembersPanel";
import { ContactDetailPanel } from "@/components/ContactDetailPanel";
import { GroupPostsTab } from "@/components/groups/posts/GroupPostsTab";
import type { GroupChatDoc } from "@/components/inbox/types";
import { TAB_ROUTES } from "@/lib/routes";
import { activityLabel, relativeTime } from "@/lib/groupDisplay";
import { cn } from "@/lib/utils";

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
 * entrar e sair continuam no card do número: aqui não se muda a configuração
 * de canal, só se navega para ela.
 */
export function GroupsPage() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const navigate = useNavigate();
  const { can, isLoading } = usePermissions(organizationId);
  const canView = can("inbox", "view_own");
  const canManageCampaigns = can("campaigns", "manage");

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
  const knownButUnmonitored = (groups ?? []).length - monitored.length;
  const anyChannelEnabled = (channels ?? []).some((c) => c.groupsEnabled);

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
      ) : monitored.length === 0 ? (
        <EmptyState
          icon={Users}
          title={
            anyChannelEnabled
              ? knownButUnmonitored > 0
                ? "Nenhum grupo acompanhado ainda"
                : "Nenhum grupo neste número"
              : "Grupos desligados nos seus números"
          }
          description={
            anyChannelEnabled
              ? knownButUnmonitored > 0
                ? `O CRM conhece ${knownButUnmonitored} sala(s) deste número, mas nenhuma está sendo acompanhada. Acompanhar é uma escolha por grupo, no card do número.`
                : "Sincronize a lista de salas no card do número em Configurações → Canais."
              : "Ligue os grupos num número bridge em Configurações → Canais para o CRM listar as salas."
          }
          action={{ label: "Abrir Canais", onClick: goToChannels }}
        />
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
                <GroupActions
                  group={group}
                  onOpenInbox={() =>
                    navigate(`${TAB_ROUTES.inbox}?conversation=${group.conversationId}`)
                  }
                  onMembers={() => setMembersFor(group._id as Id<"groupChats">)}
                  {...(canManageCampaigns
                    ? { onDispatchMembers: () => dispatchToMembers(group._id as Id<"groupChats">) }
                    : {})}
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
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
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

function GroupActions({
  group,
  onOpenInbox,
  onMembers,
  onDispatchMembers,
  align,
}: {
  group: GroupChatDoc;
  onOpenInbox: () => void;
  onMembers: () => void;
  /** F5 — abre o wizard de campanha com este grupo já selecionado. */
  onDispatchMembers?: () => void;
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
    </div>
  );
}
