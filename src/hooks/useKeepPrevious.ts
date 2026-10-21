import { useRef } from "react";

/**
 * Mantém o último valor definido de uma query reativa enquanto os ARGS mudam
 * (ex.: o `limit` subiu por "Carregar mais") — o `useQuery` do Convex devolve
 * `undefined` até o resultado dos args novos chegar, e a lista piscaria em
 * "carregando". Trocar `resetKey` (outra conversa, outro filtro) descarta o
 * valor guardado, para nunca mostrar dados da chave anterior.
 */
export function useKeepPrevious<T>(value: T | undefined, resetKey: unknown): T | undefined {
  const ref = useRef<{ key: unknown; value: T } | null>(null);
  if (value !== undefined) {
    ref.current = { key: resetKey, value };
    return value;
  }
  if (ref.current && Object.is(ref.current.key, resetKey)) return ref.current.value;
  return undefined;
}
