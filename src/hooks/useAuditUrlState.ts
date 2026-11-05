import { useCallback } from "react";
import type { SearchParamState } from "@/hooks/useSearchParamState";
import { useOpenEntityParam } from "@/hooks/useOpenEntityParam";
import { useSearchParamState } from "@/hooks/useSearchParamState";
import {
  actionCodec,
  actorCodec,
  entityCodec,
  fromCodec,
  severityCodec,
  toCodec,
  ALL,
} from "@/lib/auditFilters";

const NOSCROLL = { preventScrollReset: true } as const;

/**
 * Filtrar recolhe o item aberto na mesma escrita: o `?log=` não fica órfão
 * quando a linha sai da lista e, principalmente, fechar depois (`navigate(-1)`
 * da entrada que abrimos) não desfaz o filtro.
 */
function filterSetter<T>(param: SearchParamState<T>) {
  return (next: T) => param.set(next, { also: { log: null } });
}

/**
 * Estado do Histórico de alterações que vive na URL: filtros
 * `?entity=&action=&actor=&severity=&from=&to=` (replace, padrão fora da URL)
 * e `?log=` (item aberto; push, então o "voltar" fecha). O `cursorStack`
 * fica em estado da tela.
 */
export function useAuditUrlState() {
  const severity = useSearchParamState("severity", severityCodec, NOSCROLL);
  const entity = useSearchParamState("entity", entityCodec, NOSCROLL);
  const action = useSearchParamState("action", actionCodec, NOSCROLL);
  const actor = useSearchParamState("actor", actorCodec, NOSCROLL);
  const from = useSearchParamState("from", fromCodec, NOSCROLL);
  const to = useSearchParamState("to", toCodec, NOSCROLL);
  const log = useOpenEntityParam("log");

  const { set: setSeverityParam } = severity;
  const { set: setFromParam } = from;

  /** Limpa todos os filtros numa navegação só (dois `set` seguidos não se compõem). */
  const clearAll = useCallback(() => {
    setSeverityParam(ALL, {
      also: { entity: null, action: null, actor: null, from: null, to: null, log: null },
    });
  }, [setSeverityParam]);

  /** Limpa o período numa navegação só. */
  const clearDates = useCallback(() => {
    setFromParam("", { also: { to: null, log: null } });
  }, [setFromParam]);

  /** Abre (push, o "voltar" fecha) ou fecha (volta a entrada que abrimos). */
  const { open: openLog, close: closeLog } = log;
  const setOpenLog = useCallback(
    (id: string | null) => (id ? openLog(id) : closeLog()),
    [openLog, closeLog]
  );

  return {
    severity: severity.value,
    setSeverity: filterSetter(severity),
    entity: entity.value,
    setEntity: filterSetter(entity),
    action: action.value,
    setAction: filterSetter(action),
    actor: actor.value,
    setActor: filterSetter(actor),
    from: from.value,
    setFrom: filterSetter(from),
    to: to.value,
    setTo: filterSetter(to),
    openLogId: log.id,
    setOpenLog,
    clearAll,
    clearDates,
  };
}
