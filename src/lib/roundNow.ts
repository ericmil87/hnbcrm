/**
 * Relógio arredondado para argumentos de query: `findSlots` recebe o minuto; `listFor*` e `listPending`, a
 * hora. Arquivo mínimo (sem dependências) porque o gate da conversa e do lead o carrega em TODAS as telas.
 */
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export type NowUnit = "minute" | "hour";

/** Arredonda PARA BAIXO (o servidor também arredonda assim nas listas). `now` inválido vira 0. */
export function roundNow(now: number, unit: NowUnit): number {
  if (!Number.isFinite(now) || now < 0) return 0;
  const size = unit === "hour" ? HOUR_MS : MINUTE_MS;
  return Math.floor(now / size) * size;
}
