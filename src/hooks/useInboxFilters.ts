import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useInboxChannelAccounts } from "@/hooks/useInboxChannelAccounts";
import { useOrgModules } from "@/hooks/useOrgModules";
import { useSearchParamState } from "@/hooks/useSearchParamState";
import {
  INBOX_FILTER_STORAGE_KEY,
  accountChipOptions,
  parseStoredInboxFilter,
  sanitizeInboxFilter,
  showChannelChip,
  type InboxFilterState,
} from "@/lib/channelAccounts";
import {
  KIND_FILTER_KEY,
  readKindFilter,
  type ConversationKindFilter,
  type InboxChipState,
} from "@/lib/inboxState";
import { booleanParam, stringParam } from "@/lib/searchParamState";
import {
  EMPTY_QUEUE_FILTER,
  queueFilterArgs,
  type InboxQueueFilter,
} from "@/components/inbox/central/InboxQueueBar";

/**
 * Filtros da lista de Conversas.
 * - Estado de tela, na URL (replace, não polui o histórico): `?archived=1`,
 *   `?label=<id>` e `?unread=1` (chip "Não lidas" do celular).
 * - Preferência pessoal, em `localStorage`: Diretas/Grupos e Canal/Conta.
 * - Fila (Central, opcional por org): estado local.
 */
export function useInboxFilters(organizationId: Id<"organizations">) {
  const archivedParam = useSearchParamState("archived", booleanParam);
  const labelParam = useSearchParamState("label", stringParam);
  const unreadParam = useSearchParamState("unread", booleanParam);
  const showArchived = archivedParam.value;
  const unreadOnly = unreadParam.value;
  const setShowArchived = archivedParam.set;

  const conversationLabels = useQuery(api.conversations.listLabels, { organizationId });
  // Etiqueta apagada (ou colada de outra org) na URL não pode deixar a lista
  // vazia sem controle para sair: id que não existe mais vale como "sem filtro".
  const filterLabelId =
    labelParam.value && (conversationLabels === undefined || conversationLabels.some((l) => l._id === labelParam.value))
      ? labelParam.value
      : null;
  const setFilterLabelId = labelParam.set;

  // Diretas x grupos (v0.57). Persistido porque quem acompanha 30 grupos quase
  // sempre quer a mesma aba de novo; leitura e escrita protegidas porque o
  // localStorage lança em janela anônima e com dados de site bloqueados.
  const [kindFilter, setKindFilter] = useState<ConversationKindFilter>(() => readKindFilter());
  useEffect(() => {
    try {
      window.localStorage.setItem(KIND_FILTER_KEY, kindFilter);
    } catch {
      /* sem persistência é só perder a preferência, não quebrar a tela */
    }
  }, [kindFilter]);

  // Chips Canal e Conta (D11; valem para WhatsApp com 2+ números, sem módulo
  // Meta). Persistidos com try/catch, como o filtro acima. O valor salvo é
  // validado contra as contas atuais antes de virar arg da query.
  const { accounts: channelAccounts, byId: accountById } = useInboxChannelAccounts(organizationId);
  const [storedChannelFilter, setStoredChannelFilter] = useState<InboxFilterState>(() => {
    try {
      return parseStoredInboxFilter(window.localStorage.getItem(INBOX_FILTER_STORAGE_KEY));
    } catch {
      return { channel: null, configId: null };
    }
  });
  const sanitizedFilter = sanitizeInboxFilter(channelAccounts, storedChannelFilter);
  const channelChipVisible = showChannelChip(channelAccounts);
  const accountChoices = accountChipOptions(channelAccounts, sanitizedFilter.channel);
  // Filtro escondido (chip invisível) nunca fica ativo às cegas.
  const channelFilter: InboxFilterState = {
    channel: channelChipVisible ? sanitizedFilter.channel : null,
    configId: accountChoices.length > 0 ? sanitizedFilter.configId : null,
  };
  const updateChannelFilter = (next: InboxFilterState) => {
    setStoredChannelFilter(next);
    try {
      window.localStorage.setItem(INBOX_FILTER_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* sem persistência é só perder a preferência */
    }
  };
  const channelOptions = Array.from(new Set(channelAccounts.map((a) => a.channel)));
  const channelArgs = {
    ...(channelFilter.channel
      ? { channel: channelFilter.channel as "whatsapp" | "instagram" | "messenger" }
      : {}),
    ...(channelFilter.configId
      ? { channelConfigId: channelFilter.configId as Id<"channelConfigs"> }
      : {}),
  };

  // MVP "Central" (opcional por org): filas por setor/unidade, chips e o
  // roteamento no header. Com os módulos desligados nada disto aparece e
  // `getConversations` recebe exatamente os args de antes.
  const { modules: centralModules, anyEnabled: centralEnabled } = useOrgModules(organizationId);
  const queuesEnabled = centralModules.departments || centralModules.units;
  const [queueFilter, setQueueFilter] = useState<InboxQueueFilter>(EMPTY_QUEUE_FILTER);
  const inboxQueues = useQuery(
    api.conversationRouting.getInboxQueues,
    queuesEnabled ? { organizationId } : "skip"
  );
  const queueArgs = queueFilterArgs(queueFilter, centralModules);
  const queueFilterActive = Object.keys(queueArgs).length > 0;
  const unitById = new Map((inboxQueues?.units ?? []).map((u) => [u._id as string, u]));
  const departmentById = new Map((inboxQueues?.departments ?? []).map((d) => [d._id as string, d]));

  /** Chips do celular: etiqueta e "Não lidas" numa escrita só da URL; tipo no localStorage. */
  const applyChipState = (next: InboxChipState) => {
    if (next.kind !== kindFilter) setKindFilter(next.kind);
    if (next.unreadOnly !== unreadOnly || next.labelId !== filterLabelId) {
      unreadParam.set(next.unreadOnly, { also: { label: next.labelId } });
    }
  };

  return {
    // URL
    showArchived,
    unreadOnly,
    applyChipState,
    setShowArchived,
    filterLabelId,
    setFilterLabelId,
    conversationLabels,
    // localStorage
    kindFilter,
    setKindFilter,
    channelAccounts,
    accountById,
    channelFilter,
    updateChannelFilter,
    channelChipVisible,
    accountChoices,
    channelOptions,
    channelArgs,
    // Central
    centralModules,
    centralEnabled,
    queuesEnabled,
    queueFilter,
    setQueueFilter,
    inboxQueues,
    queueArgs,
    queueFilterActive,
    unitById,
    departmentById,
  };
}
