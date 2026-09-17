/**
 * Passo 1 — nome e destinos. Um número por publicação: escolhido o primeiro
 * grupo, os grupos dos outros números ficam travados, porque o disparo sai de
 * uma sessão só (o servidor recusa destinos de canais diferentes).
 */
import { useMemo } from "react";
import { Lock, Users, Wifi, WifiOff } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import type { GroupChatDoc } from "@/components/inbox/types";
import { MAX_POST_TARGETS } from "../../../../convex/lib/groupPostCore";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { ChannelGroupSettings } from "./types";
import type { PostDraft } from "./wizardState";

interface StepTargetsProps {
  draft: PostDraft;
  setDraft: (updater: (prev: PostDraft) => PostDraft) => void;
  groups: GroupChatDoc[] | undefined;
  channels: ChannelGroupSettings[] | undefined;
  onGoToGroups: () => void;
}

export function StepTargets({ draft, setDraft, groups, channels, onGoToGroups }: StepTargetsProps) {
  const eligible = useMemo(
    () =>
      (groups ?? []).filter(
        (g) => g.monitored && g.removedAt === undefined && g.leftAt === undefined && g.conversationId
      ),
    [groups]
  );

  const byChannel = useMemo(() => {
    const map = new Map<string, GroupChatDoc[]>();
    for (const g of eligible) {
      const list = map.get(g.channelConfigId) ?? [];
      list.push(g);
      map.set(g.channelConfigId, list);
    }
    return map;
  }, [eligible]);

  const selected = new Set(draft.groupChatIds as string[]);
  const lockedChannelId = useMemo(() => {
    const first = eligible.find((g) => selected.has(g._id));
    return first?.channelConfigId ?? null;
  }, [eligible, draft.groupChatIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const capReached = draft.groupChatIds.length >= MAX_POST_TARGETS;

  const toggle = (groupChatId: string) => {
    setDraft((prev) => {
      const has = prev.groupChatIds.includes(groupChatId as Id<"groupChats">);
      return {
        ...prev,
        groupChatIds: has
          ? prev.groupChatIds.filter((id) => id !== groupChatId)
          : [...prev.groupChatIds, groupChatId as Id<"groupChats">],
      };
    });
  };

  const channelInfo = (id: string): ChannelGroupSettings | undefined =>
    (channels ?? []).find((c) => c.channelConfigId === id);

  return (
    <div className="space-y-5">
      <Input
        label="Nome da publicação"
        placeholder="Ex.: Mensagem do dia"
        value={draft.name}
        maxLength={120}
        onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
      />

      <div>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium text-text-primary">Onde publicar</h3>
          <span className="text-xs text-text-muted tabular-nums">
            {draft.groupChatIds.length} de {MAX_POST_TARGETS} grupos
          </span>
        </div>

        {groups === undefined ? (
          <p className="text-sm text-text-muted">Carregando grupos…</p>
        ) : eligible.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Nenhum grupo acompanhado"
            description="Uma publicação só pode ir para grupos que o CRM acompanha. Comece a acompanhar um grupo na aba Grupos."
            action={{ label: "Ver grupos", onClick: onGoToGroups }}
          />
        ) : (
          <div className="space-y-4">
            {Array.from(byChannel.entries()).map(([channelId, list]) => {
              const info = channelInfo(channelId);
              const connected = info?.bridgeSessionState === "connected";
              const channelLocked = lockedChannelId !== null && lockedChannelId !== channelId;
              const groupsOff = info ? !info.groupsEnabled : false;
              return (
                <div key={channelId} className="rounded-card border border-border bg-surface-raised">
                  <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                    <span className="text-sm font-medium text-text-primary">
                      {info?.displayName ?? "Número bridge"}
                    </span>
                    {connected ? (
                      <Badge variant="success">
                        <span className="inline-flex items-center gap-1">
                          <Wifi size={10} /> conectado
                        </span>
                      </Badge>
                    ) : (
                      <Badge variant="warning">
                        <span className="inline-flex items-center gap-1">
                          <WifiOff size={10} /> {info?.bridgeSessionState ?? "sem sessão"}
                        </span>
                      </Badge>
                    )}
                    {groupsOff && <Badge variant="error">grupos desligados</Badge>}
                    {channelLocked && (
                      <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-text-muted">
                        <Lock size={11} /> outro número já escolhido
                      </span>
                    )}
                  </div>
                  <ul className="divide-y divide-border">
                    {list.map((group) => {
                      const isSelected = selected.has(group._id);
                      const disabled =
                        channelLocked || groupsOff || (capReached && !isSelected);
                      return (
                        <li key={group._id} className="px-3 py-2.5">
                          <Checkbox
                            checked={isSelected}
                            disabled={disabled}
                            onChange={() => toggle(group._id)}
                            containerClassName="w-full"
                            label={
                              <span className="flex flex-wrap items-center gap-1.5">
                                <span className="font-medium text-text-primary">{group.subject}</span>
                                {group.isAnnounce && <Badge variant="warning">só admin publica</Badge>}
                                {group.isAnnounce && !group.weAreAdmin && (
                                  <Badge variant="error">não somos admin</Badge>
                                )}
                              </span>
                            }
                            description={
                              <span className="text-xs text-text-muted">
                                {group.participantsCount} membro
                                {group.participantsCount === 1 ? "" : "s"}
                              </span>
                            }
                          />
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        )}

        {capReached && (
          <p className="mt-2 text-xs text-semantic-warning">
            Teto de {MAX_POST_TARGETS} grupos por publicação. Crie outra publicação para o resto.
          </p>
        )}
        <p className="mt-2 text-xs text-text-muted">
          Um grupo com "só admin publica" precisa que o seu número seja administrador — senão o
          WhatsApp recusa a mensagem na hora do disparo.
        </p>
      </div>
    </div>
  );
}
