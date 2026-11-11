/**
 * Conectores falsos do `safeFetch` para testes (não é módulo do Convex: o
 * nome tem dois pontos e fica fora do glob de módulos dos testes).
 */
import { SafeFetchConnectRequest, SafeFetchDeps } from "./safeFetch";
import { setSafeFetchDepsForTests } from "./safeFetchNode";

/**
 * Para testes que já simulam a rede com `vi.stubGlobal("fetch")`: todo nome
 * resolve para `resolveTo` (público por padrão) e a conexão usa o `fetch`
 * global (sem pinagem — só para teste). `onConnect` registra cada conexão.
 */
export function fetchBackedSafeFetchDeps(
  opts: { resolveTo?: string | ((host: string) => string[]); onConnect?: (req: SafeFetchConnectRequest) => void } = {}
): SafeFetchDeps {
  return {
    resolve: async (host) => {
      const r = opts.resolveTo ?? "93.184.216.34";
      const list = typeof r === "function" ? r(host) : [r];
      return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    connect: async (req) => {
      opts.onConnect?.(req);
      const res = await fetch(req.url.toString(), {
        method: "GET",
        headers: req.headers,
        signal: req.signal,
        redirect: "manual",
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      return {
        status: res.status,
        headers,
        body: (async function* () {
          if (buf.byteLength) yield buf;
        })(),
        cancel: () => {},
      };
    },
  };
}

export function useFetchBackedSafeFetchForTests(opts?: Parameters<typeof fetchBackedSafeFetchDeps>[0]): void {
  setSafeFetchDepsForTests(fetchBackedSafeFetchDeps(opts));
}
