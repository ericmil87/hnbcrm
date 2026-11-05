// Parte pura do estado na URL (`useSearchParamState`): como cada tipo de
// parâmetro é lido/escrito e o mecanismo de "escrita em voo". Sem React.

/** Como um parâmetro vira valor (`parse`) e volta para texto (`serialize`; `null` = remover da URL). */
export interface ParamCodec<T> {
  parse(raw: string | null): T;
  serialize(value: T): string | null;
}

/** Texto livre ou id. Vazio equivale a ausente. */
export const stringParam: ParamCodec<string | null> = {
  parse: (raw) => (raw && raw.length > 0 ? raw : null),
  serialize: (value) => (value && value.length > 0 ? value : null),
};

/** Um de `values`; qualquer outra coisa volta para `fallback`, que não é escrito na URL. */
export function enumParam<T extends string>(values: readonly T[], fallback: T): ParamCodec<T> {
  return {
    parse: (raw) => (raw !== null && (values as readonly string[]).includes(raw) ? (raw as T) : fallback),
    serialize: (value) => (value === fallback ? null : value),
  };
}

/** Marcador `?param=1`: presente = verdadeiro, ausente = falso. */
export const booleanParam: ParamCodec<boolean> = {
  parse: (raw) => raw === "1",
  serialize: (value) => (value ? "1" : null),
};

/** Número (inteiro por padrão); ausente ou inválido = `null`. */
export function numberParam(
  opts: { integer?: boolean; min?: number; max?: number } = {}
): ParamCodec<number | null> {
  const { integer = true, min, max } = opts;
  return {
    parse: (raw) => {
      if (raw === null || raw.trim() === "") return null;
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      if (integer && !Number.isInteger(n)) return null;
      if (min !== undefined && n < min) return null;
      if (max !== undefined && n > max) return null;
      return n;
    },
    serialize: (value) => (value === null || !Number.isFinite(value) ? null : String(value)),
  };
}

/** Lista separada por vírgula; vazia equivale a ausente. */
export const listParam: ParamCodec<string[]> = {
  parse: (raw) => (raw ? raw.split(",").filter((item) => item.length > 0) : []),
  serialize: (value) => {
    const items = value.filter((item) => item.length > 0);
    return items.length > 0 ? items.join(",") : null;
  },
};

/**
 * Cópia de `prev` com as escritas aplicadas (`null` remove o parâmetro). Várias
 * escritas numa chamada só: dois `setSearchParams` funcionais seguidos não se
 * compõem (o segundo vence), então quem muda mais de um parâmetro os junta aqui.
 */
export function writeParams(
  prev: URLSearchParams,
  writes: Readonly<Record<string, string | null>>
): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const [key, value] of Object.entries(writes)) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  return next;
}

/**
 * Escrita nossa na URL ainda em voo. O router aplica `setSearchParams` de forma
 * assíncrona: existe pelo menos um render em que o estado da tela já é o novo e
 * o param ainda é o antigo. `target` é o valor pedido e `stale` o que estava na
 * URL na hora. Enquanto a URL mostrar `stale`, o efeito URL → estado tem de
 * ficar quieto (reaplicar o valor antigo desfazia o clique).
 */
export interface InFlightWrite {
  target: string | null;
  stale: string | null;
}

export function beginWrite(current: string | null, target: string | null): InFlightWrite {
  return { target, stale: current };
}

/**
 * Confronta a escrita em voo com o valor atual do param. `hold` = o efeito
 * URL → estado deve ignorar este render. A escrita se resolve quando a URL
 * alcança o alvo ou muda para qualquer outro valor (mudou por fora no meio).
 */
export function settleWrite(
  inFlight: InFlightWrite | null,
  current: string | null
): { inFlight: InFlightWrite | null; hold: boolean } {
  if (!inFlight) return { inFlight: null, hold: false };
  if (current === inFlight.target) return { inFlight: null, hold: false };
  if (current === inFlight.stale) return { inFlight, hold: true };
  return { inFlight: null, hold: false };
}
