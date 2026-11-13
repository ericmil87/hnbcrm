import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useInboxChannelAccounts } from "@/hooks/useInboxChannelAccounts";
import { useOrgModules } from "@/hooks/useOrgModules";
import { useMediaQuery } from "@/hooks/useMediaQuery";
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
  isPlausibleConvexId,
  KIND_FILTER_KEY,
  readKindFilter,
  type ConversationKindFilter,
  type InboxAiFilter,
  type InboxChipState,
} from "@/lib/inboxState";
import { booleanParam, enumParam, stringParam } from "@/lib/searchParamState";
import {
  EMPTY_QUEUE_FILTER,
  queueFilterArgs,
  type InboxQueueFilter,
} from "@/components/inbox/central/InboxQueueBar";

/**
 * Filtros da lista de Conversas.
 * - Estado de tela, na URL (replace, não polui o histórico): `?archived=1`,
 *   `?label=<id>`, `?unread=1` (chip "Não lidas" do celular), `?mine=1` ("Minhas", celular e desktop),
 *   `?stage=<stageId>` (etapa do funil) e `?ai=on|off` (IA atendendo / desligada); os três últimos são filtros de servidor.
 * - Preferência pessoal, em `localStorage`: Diretas/Grupos e Canal/Conta.
 * - Fila (Central, opcional por org): estado local.
 */
export function useInboxFilters(organizationId: Id<"organizations">) {
  const archivedParam = useSearchParamState("archived", booleanParam);
  const labelParam = useSearchParamState("label", stringParam);
  const unreadParam = useSearchParamState("unread", booleanParam);
  // "Minhas": valem no celular (chip) e no desktop (botão); filtro de servidor (`mine`).
  const mineParam = useSearchParamState("mine", booleanParam);
  const mine = mineParam.value;
  const mineArgs = mine ? { mine: true as const } : {};
  const setMine = (next: boolean) => mineParam.set(next);
  // Etapa do funil e IA: filtros de servidor (`stageId`, `ai`), celular e desktop.
  const stageParam = useSearchParamState("stage", stringParam);
  const aiParam = useSearchParamState("ai", enumParam<"" | InboxAiFilter>(["", "on", "off"], ""));
  // Id colado/corrompido na URL nunca vira arg (o validator do servidor recusaria a query inteira).
  const stageId = isPlausibleConvexId(stageParam.value) ? stageParam.value : null;
  const stageArgs = stageId ? { stageId: stageId as Id<"stages"> } : {};
  const aiFilter: InboxAiFilter | null = aiParam.value || null;
  const aiArgs = aiFilter ? { ai: aiFilter } : {};
  const setStageId = (next: string | null) => stageParam.set(next);
  const setAiFilter = (next: InboxAiFilter | null) => aiParam.set(next ?? "");
  const showArchived = archivedParam.value;
  // "Não lidas" é chip só do celular: no desktop não há controle para desligá-lo,
  // então `?unread=1` nem vale lá (gate na fonte).
  const isMobile = useMediaQuery("(max-width: 767px)");
  const unreadOnly = isMobile && unreadParam.value;
  const unreadArgs = unreadOnly ? { unreadOnly: true as const } : {};
  const setShowArchived = archivedParam.set;
  /** Celular: abrir Arquivadas desliga "Não lidas" na mesma escrita da URL. */
  const openArchived = () => archivedParam.set(true, { also: { unread: null, mine: null, stage: null, ai: null } });

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
    if (next.channel !== channelFilter.channel || next.configId !== channelFilter.configId) {
      updateChannelFilter({ channel: next.channel, configId: next.configId });
    }
    if (
      next.unreadOnly !== unreadOnly ||
      next.labelId !== filterLabelId ||
      next.mine !== mine ||
      next.stageId !== stageId ||
      next.ai !== aiFilter
    ) {
      unreadParam.set(next.unreadOnly, {
        also: { label: next.labelId, mine: next.mine ? "1" : null, stage: next.stageId, ai: next.ai },
      });
    }
  };

  return {
    // URL
    showArchived,
    unreadOnly,
    unreadArgs,
    mine,
    mineArgs,
    setMine,
    stageId,
    stageArgs,
    setStageId,
    aiFilter,
    aiArgs,
    setAiFilter,
    openArchived,
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
