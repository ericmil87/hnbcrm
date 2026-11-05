import { useCallback } from "react";
import { useSearchParamState } from "@/hooks/useSearchParamState";
import {
  actionCodec,
  actorCodec,
  entityCodec,
  fromCodec,
  logCodec,
  severityCodec,
  toCodec,
  ALL,
} from "@/lib/auditFilters";

/**
 * Estado do Histórico de alterações que vive na URL: filtros
 * `?entity=&action=&actor=&severity=&from=&to=` (replace, padrão fora da URL)
 * e `?log=` (item aberto; push, então o "voltar" fecha). O `cursorStack`
 * fica em estado da tela.
 */
export function useAuditUrlState() {
  const severity = useSearchParamState("severity", severityCodec);
  const entity = useSearchParamState("entity", entityCodec);
  const action = useSearchParamState("action", actionCodec);
  const actor = useSearchParamState("actor", actorCodec);
  const from = useSearchParamState("from", fromCodec);
  const to = useSearchParamState("to", toCodec);
  const log = useSearchParamState("log", logCodec);

  const { set: setSeverityParam } = severity;
  const { set: setFromParam } = from;
  const { set: setLogParam } = log;

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

  /** Abre com push (o "voltar" fecha); fechar substitui a entrada. */
  const setOpenLog = useCallback(
    (id: string | null) => setLogParam(id, { history: id ? "push" : "replace" }),
    [setLogParam]
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
    openLogId: log.value,
    setOpenLog,
    clearAll,
    clearDates,
  };
}
