"use node";
/**
 * `safeFetch` com rede real (Node): resolve o DNS com `dns.lookup` e conecta
 * por `https.request` NO IP validado pelo núcleo (`lib/safeFetch.ts`). O
 * `lookup` da conexão é substituído por um que devolve só esse IP — não há
 * segunda resolução (defesa contra DNS rebinding) — e o SNI/Host/validação do
 * certificado continuam pelo NOME (`servername`).
 *
 * Só importado por arquivos "use node" (actions). Sem cookies, sem agente
 * compartilhado (keep-alive desligado), sem proxy de ambiente.
 */
import { lookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import zlib from "node:zlib";
import {
  ResolvedAddress,
  SafeFetchConnectRequest,
  SafeFetchDeps,
  SafeFetchOptions,
  SafeFetchRawResponse,
  SafeFetchResult,
  safeFetchCore,
} from "./safeFetch";

async function nodeResolve(hostname: string): Promise<ResolvedAddress[]> {
  const all = await lookup(hostname, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}

function flattenHeaders(res: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(res.headers)) {
    if (val === undefined || k === "set-cookie") continue;
    out[k.toLowerCase()] = Array.isArray(val) ? val.join(", ") : String(val);
  }
  return out;
}

function nodeConnect(req: SafeFetchConnectRequest): Promise<SafeFetchRawResponse> {
  return new Promise((resolve, reject) => {
    const { url, address } = req;
    const pinnedLookup = (
      _host: string,
      options: unknown,
      cb: (err: Error | null, addr: string | { address: string; family: number }[], family?: number) => void
    ) => {
      const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
      if (wantsAll) cb(null, [{ address: address.address, family: address.family }]);
      else cb(null, address.address, address.family);
    };
    const request = https.request(
      {
        protocol: "https:",
        hostname: req.servername,
        // SNI só com nome (IP literal no SNI é proibido pela RFC 6066).
        servername: isIP(req.servername) ? undefined : req.servername,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { ...req.headers, Host: url.host },
        lookup: pinnedLookup as never,
        agent: false,
        signal: req.signal,
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
      },
      (res) => {
        // Defesa extra: o socket tem de estar no IP validado.
        const remote = res.socket?.remoteAddress?.replace(/^::ffff:/, "");
        const expected = address.address.replace(/^::ffff:/, "");
        if (remote && remote !== expected) {
          request.destroy();
          reject(new Error("pinned address mismatch"));
          return;
        }
        const encoding = String(res.headers["content-encoding"] ?? "identity").toLowerCase().trim();
        let body: AsyncIterable<Uint8Array> = res;
        if (encoding === "gzip" || encoding === "x-gzip") body = res.pipe(zlib.createGunzip());
        else if (encoding === "deflate") body = res.pipe(zlib.createInflate());
        else if (encoding === "br") body = res.pipe(zlib.createBrotliDecompress());
        resolve({
          status: res.statusCode ?? 0,
          headers: flattenHeaders(res),
          body,
          cancel: () => {
            request.destroy();
            res.destroy();
          },
        });
      }
    );
    request.on("error", reject);
    request.end();
  });
}

export const nodeSafeFetchDeps: SafeFetchDeps = { resolve: nodeResolve, connect: nodeConnect };

// ---------------------------------------------------------------------------
// Costura de teste (só sob vitest). Em produção não há como trocar a rede.
// ---------------------------------------------------------------------------

let testDeps: SafeFetchDeps | null = null;

function assertTestEnv() {
  if (process.env.VITEST !== "true") throw new Error("somente em teste");
}

export function setSafeFetchDepsForTests(deps: SafeFetchDeps | null): void {
  assertTestEnv();
  testDeps = deps;
}

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

export function useFetchBackedSafeFetchForTests(
  opts?: Parameters<typeof fetchBackedSafeFetchDeps>[0]
): void {
  setSafeFetchDepsForTests(fetchBackedSafeFetchDeps(opts));
}

/** Ponto de entrada das actions Node. Nunca lança. */
export function safeFetch(url: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  return safeFetchCore(url, opts, testDeps ?? nodeSafeFetchDeps);
}
