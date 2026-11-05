// Parte pura do estado do Histórico de alterações que vive na URL
// (`useAuditUrlState`): `?entity=&action=&actor=&severity=&from=&to=` e `?log=`.
// O `cursorStack` da paginação NÃO vai para a URL (o cursor do Convex expira).
import { enumParam, stringParam, type ParamCodec } from "./searchParamState";

/** Valor "sem filtro" dos selects da tela; não aparece na URL. */
export const ALL = "all";

export const AUDIT_SEVERITY_VALUES = [ALL, "low", "medium", "high", "critical"] as const;
export const AUDIT_ACTION_VALUES = [ALL, "create", "update", "delete", "move", "assign", "handoff"] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITY_VALUES)[number];
export type AuditAction = (typeof AUDIT_ACTION_VALUES)[number];

/** `YYYY-MM-DD` de um dia que existe no calendário (31/02 não vale). */
export function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

/** Data `YYYY-MM-DD`; inválida ou ausente = `""` (sem limite). */
export const isoDateParam: ParamCodec<string> = {
  parse: (raw) => (raw !== null && isIsoDate(raw) ? raw : ""),
  serialize: (value) => (isIsoDate(value) ? value : null),
};

/** Texto livre cujo padrão é `"all"`. */
export const allStringParam: ParamCodec<string> = {
  parse: (raw) => (raw && raw.length > 0 ? raw : ALL),
  serialize: (value) => (value && value !== ALL ? value : null),
};

export const severityCodec = enumParam(AUDIT_SEVERITY_VALUES, ALL);
export const actionCodec = enumParam(AUDIT_ACTION_VALUES, ALL);
export const entityCodec = allStringParam;
export const actorCodec = allStringParam;
export const fromCodec = isoDateParam;
export const toCodec = isoDateParam;
export const logCodec = stringParam;

/**
 * Ator da URL só vale se existir na org (id colado de outra org ou malformado
 * não pode chegar à query). `pending`: há ator na URL e a lista ainda carrega.
 */
export function resolveAuditActor(
  actor: string,
  actorIds: readonly string[] | undefined
): { actor: string; pending: boolean } {
  if (actor === ALL) return { actor: ALL, pending: false };
  if (actorIds === undefined) return { actor: ALL, pending: true };
  return { actor: actorIds.includes(actor) ? actor : ALL, pending: false };
}
