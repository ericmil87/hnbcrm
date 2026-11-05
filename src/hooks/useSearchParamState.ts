import { useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router";
import {
  beginWrite,
  settleWrite,
  writeParams,
  type InFlightWrite,
  type ParamCodec,
} from "@/lib/searchParamState";

export interface SetParamOptions {
  /** `push` para abrir uma entidade (o "voltar" fecha); `replace` para filtros. */
  history?: "push" | "replace";
  /** Outros parâmetros escritos na MESMA navegação (`null` remove). */
  also?: Readonly<Record<string, string | null>>;
}

export interface SearchParamState<T> {
  /** Valor lido da URL pelo codec. */
  value: T;
  /** Texto cru do param (`null` = ausente). */
  raw: string | null;
  set: (next: T, options?: SetParamOptions) => void;
  /**
   * Para efeitos URL → estado: `true` enquanto a URL ainda mostra o valor
   * antigo de uma escrita nossa em voo (o efeito deve ficar quieto). Chame uma
   * vez por execução do efeito; o resultado vale para o render atual.
   */
  isInFlight: () => boolean;
}

/**
 * Estado de tela guardado num parâmetro da URL (a URL é a fonte da verdade).
 * Filtros usam `replace` (não poluem o histórico); abrir uma entidade usa
 * `push`. O mecanismo de "escrita em voo" fica aqui, uma vez só: o router
 * aplica `setSearchParams` de forma assíncrona e, sem ele, um efeito
 * URL → estado reaplicava o valor antigo e desfazia o clique.
 */
export function useSearchParamState<T>(
  key: string,
  codec: ParamCodec<T>,
  { history = "replace" }: { history?: "push" | "replace" } = {}
): SearchParamState<T> {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(key);
  const value = useMemo(() => codec.parse(raw), [codec, raw]);
  const inFlightRef = useRef<InFlightWrite | null>(null);

  const set = useCallback(
    (next: T, options: SetParamOptions = {}) => {
      const serialized = codec.serialize(next);
      inFlightRef.current = beginWrite(raw, serialized);
      setSearchParams(
        (prev) => writeParams(prev, { [key]: serialized, ...options.also }),
        { replace: (options.history ?? history) === "replace" }
      );
    },
    [codec, history, key, raw, setSearchParams]
  );

  const isInFlight = useCallback(() => {
    const result = settleWrite(inFlightRef.current, raw);
    inFlightRef.current = result.inFlight;
    return result.hold;
  }, [raw]);

  return { value, raw, set, isInFlight };
}
