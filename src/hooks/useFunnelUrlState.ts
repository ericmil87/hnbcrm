import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import type { Id } from "../../convex/_generated/dataModel";
import {
  lastBoardStorageKey,
  parseFunnelFilters,
  pickInitialBoardId,
  writeFunnelFilters,
  DEFAULT_FUNNEL_FILTERS,
  type FunnelFilters,
  type FunnelView,
} from "@/lib/funnelFilters";

/**
 * Estado do Funil que vive na URL.
 *
 * - `?board=`: só leitura, na escolha do funil inicial (depois dela o usuário manda).
 * - `?lead=`: abre o painel do lead; escrito com replace (como sempre foi).
 * - `?view=&q=&owner=&temp=&priority=&unit=`: modo e filtros, sempre com replace;
 *   o valor padrão sai da URL.
 * - Último funil por org: `localStorage` (preferência pessoal, não é filtro de tela).
 */
export function useFunnelUrlState(
  organizationId: Id<"organizations">,
  boards: readonly { _id: Id<"boards"> }[] | undefined
) {
  const [searchParams, setSearchParams] = useSearchParams();
  const boardParam = searchParams.get("board");
  const leadParam = searchParams.get("lead");
  const filters = useMemo(() => parseFunnelFilters(searchParams), [searchParams]);

  const [selectedBoardId, setSelectedBoardId] = useState<Id<"boards"> | null>(null);
  const [selectedLeadId, setSelectedLeadId] = useState<Id<"leads"> | null>(null);

  // Board inicial: query param (?board=) > último visto (localStorage por org) > primeiro board.
  useEffect(() => {
    if (!boards || boards.length === 0 || selectedBoardId) return;
    const stored = window.localStorage.getItem(lastBoardStorageKey(organizationId));
    setSelectedBoardId(pickInitialBoardId(boards, boardParam, stored) as Id<"boards">);
  }, [boards, selectedBoardId, boardParam, organizationId]);

  // Lembra o último board visto por org, para a próxima visita sem query param.
  useEffect(() => {
    if (!selectedBoardId) return;
    window.localStorage.setItem(lastBoardStorageKey(organizationId), selectedBoardId);
  }, [selectedBoardId, organizationId]);

  // O painel do lead vive na URL (`?lead=`): quem chega de Tarefas/Conversas
  // abre direto no lead certo, e voltar no browser reabre o painel.
  const openLeadPanel = useCallback(
    (leadId: Id<"leads">) => {
      setSelectedLeadId(leadId);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("lead", leadId);
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const closeLeadPanel = useCallback(() => {
    setSelectedLeadId(null);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("lead");
        return next;
      },
      { replace: true }
    );
  }, [setSearchParams]);

  // Deep-link: troca para o board do lead (se preciso) e abre o painel.
  const handleDeepLinkLead = useCallback(
    (lead: { _id: Id<"leads">; boardId: Id<"boards"> }) => {
      if (lead.boardId) setSelectedBoardId((cur) => (cur === lead.boardId ? cur : lead.boardId));
      setSelectedLeadId((cur) => (cur === lead._id ? cur : lead._id));
    },
    []
  );

  const setFilters = useCallback(
    (changes: Partial<FunnelFilters>) => {
      setSearchParams((prev) => writeFunnelFilters(prev, changes), {
        replace: true,
        preventScrollReset: true,
      });
    },
    [setSearchParams]
  );

  const setView = useCallback((view: FunnelView) => setFilters({ view }), [setFilters]);

  /** Limpa busca e filtros, mantendo o modo. */
  const clearFilters = useCallback(
    () =>
      setFilters({
        q: DEFAULT_FUNNEL_FILTERS.q,
        owner: DEFAULT_FUNNEL_FILTERS.owner,
        temp: DEFAULT_FUNNEL_FILTERS.temp,
        priority: DEFAULT_FUNNEL_FILTERS.priority,
        unit: DEFAULT_FUNNEL_FILTERS.unit,
      }),
    [setFilters]
  );

  return {
    filters,
    setFilters,
    setView,
    clearFilters,
    leadParam,
    selectedBoardId,
    setSelectedBoardId,
    selectedLeadId,
    openLeadPanel,
    closeLeadPanel,
    handleDeepLinkLead,
  };
}
