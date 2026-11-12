"use node";
/**
 * `safeFetch` com rede real (Node): resolve o DNS com `dns.lookup` e conecta
 * por `https.request` NO IP validado pelo núcleo (`lib/safeFetch.ts`). O
 * `lookup` da conexão é substituído por um que devolve só esse IP — não há
 * segunda resolução (defesa contra DNS rebinding) — e o SNI/Host/validação do
 * certificado continuam pelo NOME (`servername`).
 *
 * Só importado por arquivos "use node" (actions). Sem cookies, sem agente
 * compartilhado (keep-alive desligado), sem proxy de ambiente. Corpo
 * comprimido: só gzip/deflate/br, descomprimido por `stream.pipeline` (erro
 * do descompressor propaga para a leitura); qualquer outro `content-encoding`
 * é recusado. O limite de bytes do núcleo conta o corpo JÁ descomprimido.
 */
import { lookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { pipeline, Readable } from "node:stream";
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

type LookupCallback = (
  err: Error | null,
  addr: string | { address: string; family: number }[],
  family?: number
) => void;

/** `lookup` da conexão: devolve SEMPRE e SÓ o IP validado (ignora o nome pedido). */
export function makePinnedLookup(address: ResolvedAddress) {
  return (_host: string, options: unknown, cb: LookupCallback) => {
    const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
    if (wantsAll) cb(null, [{ address: address.address, family: address.family }]);
    else cb(null, address.address, address.family);
  };
}

/** Opções do `https.request` (exportado para teste). */
export function buildRequestOptions(req: SafeFetchConnectRequest): https.RequestOptions {
  const { url, address } = req;
  return {
    protocol: "https:",
    hostname: req.servername,
    // SNI só com nome (IP literal no SNI é proibido pela RFC 6066).
    servername: isIP(req.servername) ? undefined : req.servername,
    port: url.port ? Number(url.port) : 443,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers: { ...req.headers, Host: url.host },
    lookup: makePinnedLookup(address) as never,
    agent: false,
    signal: req.signal,
    minVersion: "TLSv1.2",
    rejectUnauthorized: true,
  };
}

export class UnsupportedEncodingError extends Error {
  constructor() {
    super("content-encoding não suportado");
    this.name = "UnsupportedEncodingError";
  }
}

/** Corpo decodificado pelo `content-encoding`; desconhecido lança. */
export function decodedBody(encodingHeader: string | undefined, res: Readable): AsyncIterable<Uint8Array> {
  const encoding = String(encodingHeader ?? "identity").toLowerCase().trim();
  if (encoding === "" || encoding === "identity") return res;
  let decoder: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress;
  if (encoding === "gzip" || encoding === "x-gzip") decoder = zlib.createGunzip();
  else if (encoding === "deflate") decoder = zlib.createInflate();
  else if (encoding === "br") decoder = zlib.createBrotliDecompress();
  else throw new UnsupportedEncodingError();
  // pipeline: erro em qualquer ponta destrói as duas e rejeita a leitura.
  return pipeline(res, decoder, () => {});
}

function nodeConnect(req: SafeFetchConnectRequest): Promise<SafeFetchRawResponse> {
  return new Promise((resolve, reject) => {
    const request = https.request(buildRequestOptions(req), (res) => {
      // Defesa extra: o socket tem de estar no IP validado.
      const remote = res.socket?.remoteAddress?.replace(/^::ffff:/, "");
      const expected = req.address.address.replace(/^::ffff:/, "");
      if (remote && remote !== expected) {
        request.destroy();
        reject(new Error("pinned address mismatch"));
        return;
      }
      let body: AsyncIterable<Uint8Array>;
      try {
        body = decodedBody(res.headers["content-encoding"] as string | undefined, res);
      } catch (e) {
        request.destroy();
        res.destroy();
        reject(e);
        return;
      }
      resolve({
        status: res.statusCode ?? 0,
        headers: flattenHeaders(res),
        body,
        cancel: () => {
          request.destroy();
          res.destroy();
        },
      });
    });
    request.on("error", reject);
    request.end();
  });
}

export const nodeSafeFetchDeps: SafeFetchDeps = { resolve: nodeResolve, connect: nodeConnect };

// ---------------------------------------------------------------------------
// Costura de teste (só sob vitest). Em produção não há como trocar a rede.
// Os conectores falsos ficam em `safeFetchNode.test-helper.ts`.
// ---------------------------------------------------------------------------

let testDeps: SafeFetchDeps | null = null;

export function setSafeFetchDepsForTests(deps: SafeFetchDeps | null): void {
  if (process.env.VITEST !== "true") throw new Error("somente em teste");
  testDeps = deps;
}

/** Ponto de entrada das actions Node. Nunca lança. */
export function safeFetch(url: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  return safeFetchCore(url, opts, testDeps ?? nodeSafeFetchDeps);
}
