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
  /** `location.state` da entrada escrita (ex.: marcar a entrada criada por um push nosso). */
  state?: unknown;
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
  /**
   * Avisa que uma navegação NOSSA que não passa por `set` (ex.: `navigate(-1)`)
   * vai levar o param a `target`: o efeito URL → estado fica quieto até lá.
   */
  expectWrite: (target: string | null) => void;
}

/**
 * Estado de tela guardado num parâmetro da URL (a URL é a fonte da verdade).
 * Filtros usam `replace` (não poluem o histórico); abrir uma entidade usa
 * `push`. O mecanismo de "escrita em voo" fica aqui, uma vez só: o router
 * aplica `setSearchParams` de forma assíncrona e, sem ele, um efeito
 * URL → estado reaplicava o valor antigo e desfazia o clique.
 *
 * Cuidados:
 * - `codec` deve ser uma CONSTANTE de módulo (`stringParam`, ou um
 *   `const X = enumParam(...)` fora do componente). Chamar `numberParam({...})`
 *   ou `enumParam(...)` inline recria o codec a cada render; um codec que
 *   devolve objeto/array novo no `parse` faria o `useMemo` e os efeitos que
 *   dependem de `value` rodarem em loop.
 * - O estado de "escrita em voo" é POR INSTÂNCIA do hook: duas instâncias da
 *   mesma chave (em componentes diferentes) não enxergam as escritas uma da
 *   outra. Use uma instância por chave e passe `value`/`set` para baixo.
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
        {
          replace: (options.history ?? history) === "replace",
          ...(options.state !== undefined ? { state: options.state } : {}),
        }
      );
    },
    [codec, history, key, raw, setSearchParams]
  );

  const isInFlight = useCallback(() => {
    const result = settleWrite(inFlightRef.current, raw);
    inFlightRef.current = result.inFlight;
    return result.hold;
  }, [raw]);

  const expectWrite = useCallback(
    (target: string | null) => {
      inFlightRef.current = beginWrite(raw, target);
    },
    [raw]
  );

  return { value, raw, set, isInFlight, expectWrite };
}
