import { useCallback } from "react";
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
      also: { entity: null, action: null, actor: null, from: null, to: null },
    });
  }, [setSeverityParam]);

  /** Limpa o período numa navegação só. */
  const clearDates = useCallback(() => {
    setFromParam("", { also: { to: null } });
  }, [setFromParam]);

  /** Abre (push, o "voltar" fecha) ou fecha (volta a entrada que abrimos). */
  const { open: openLog, close: closeLog } = log;
  const setOpenLog = useCallback(
    (id: string | null) => (id ? openLog(id) : closeLog()),
    [openLog, closeLog]
  );

  return {
    severity: severity.value,
    setSeverity: severity.set,
    entity: entity.value,
    setEntity: entity.set,
    action: action.value,
    setAction: action.set,
    actor: actor.value,
    setActor: actor.set,
    from: from.value,
    setFrom: from.set,
    to: to.value,
    setTo: to.set,
    openLogId: log.id,
    setOpenLog,
    clearAll,
    clearDates,
  };
}
