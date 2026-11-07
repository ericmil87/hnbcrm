import { Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select } from "@/components/ui/Select";
import { accountFullLabel, channelLabel, type InboxChannelAccount, type InboxFilterState } from "@/lib/channelAccounts";
import { KIND_FILTERS, type ConversationKindFilter } from "@/lib/inboxState";

interface InboxFiltersSheetProps {
  open: boolean;
  onClose: () => void;
  kind: ConversationKindFilter;
  onKindChange: (kind: ConversationKindFilter) => void;
  showKindFilter: boolean;
  channel: InboxFilterState;
  onChannelChange: (next: InboxFilterState) => void;
  channelChipVisible: boolean;
  channelOptions: readonly string[];
  accountChoices: readonly InboxChannelAccount[];
}

/** Há algo para filtrar no ⋯ (tipo de conversa ou canal/conta)? */
export function hasSheetFilters(p: Pick<InboxFiltersSheetProps, "showKindFilter" | "channelChipVisible" | "accountChoices">) {
  return p.showKindFilter || p.channelChipVisible || p.accountChoices.length > 0;
}

/**
 * Celular: os filtros que saíram da tela (Diretas/Grupos, canal e conta), numa
 * folha aberta pelo ⋯ do cabeçalho. Mesmo estado do desktop (`useInboxFilters`,
 * preferências em localStorage).
 */
export function InboxFiltersSheet({
  open,
  onClose,
  kind,
  onKindChange,
  showKindFilter,
  channel,
  onChannelChange,
  channelChipVisible,
  channelOptions,
  accountChoices,
}: InboxFiltersSheetProps) {
  return (
    <Modal open={open} onClose={onClose} title="Filtrar conversas">
      <div className="space-y-4">
        {showKindFilter && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-text-primary" aria-hidden="true">
              Tipo de conversa
            </p>
            <SegmentedControl
              ariaLabel="Tipo de conversa"
              value={kind}
              onValueChange={(v) => onKindChange(v as ConversationKindFilter)}
              options={KIND_FILTERS.map((f) => ({
                value: f.id,
                label: f.label,
                icon: f.id === "group" ? <Users size={14} aria-hidden="true" /> : undefined,
              }))}
            />
          </div>
        )}
        {channelChipVisible && (
          <Select
            label="Canal"
            value={channel.channel ?? ""}
            onValueChange={(v) => onChannelChange({ channel: v || null, configId: null })}
            options={[
              { value: "", label: "Todos os canais" },
              ...channelOptions.map((ch) => ({ value: ch, label: channelLabel(ch) })),
            ]}
          />
        )}
        {accountChoices.length > 0 && (
          <Select
            label="Conta"
            value={channel.configId ?? ""}
            onValueChange={(v) => onChannelChange({ channel: channel.channel, configId: v || null })}
            options={[
              { value: "", label: "Todas as contas" },
              ...accountChoices.map((a) => ({ value: a._id as string, label: accountFullLabel(a) })),
            ]}
          />
        )}
        <Button type="button" size="lg" className="w-full" onClick={onClose}>
          Pronto
        </Button>
      </div>
    </Modal>
  );
}
