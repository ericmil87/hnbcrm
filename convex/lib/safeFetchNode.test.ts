// @vitest-environment node
/**
 * Parte Node do safeFetch: o `lookup` da conexão devolve só o IP validado,
 * SNI pelo nome, e o corpo comprimido é decodificado com propagação de erro.
 */
import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { buildRequestOptions, decodedBody, makePinnedLookup, UnsupportedEncodingError } from "./safeFetchNode";
import { SafeFetchConnectRequest } from "./safeFetch";

function callLookup(fn: ReturnType<typeof makePinnedLookup>, host: string, options: unknown) {
  return new Promise<{ addr: unknown; family?: number }>((resolve, reject) => {
    fn(host, options, (err, addr, family) => (err ? reject(err) : resolve({ addr, family })));
  });
}

async function readAll(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

describe("makePinnedLookup", () => {
  it("devolve só o IP validado, para qualquer nome, nos dois formatos do Node", async () => {
    const lookup = makePinnedLookup({ address: "93.184.216.34", family: 4 });
    expect(await callLookup(lookup, "rebind.attacker.example", {})).toEqual({ addr: "93.184.216.34", family: 4 });
    expect(await callLookup(lookup, "localhost", { all: true })).toEqual({
      addr: [{ address: "93.184.216.34", family: 4 }],
      family: undefined,
    });
    const v6 = makePinnedLookup({ address: "2606:4700:4700::1111", family: 6 });
    expect(await callLookup(v6, "x", 6)).toEqual({ addr: "2606:4700:4700::1111", family: 6 });
  });
});

describe("buildRequestOptions", () => {
  const base = (servername: string, url: string): SafeFetchConnectRequest => ({
    url: new URL(url),
    address: { address: "93.184.216.34", family: 4 },
    servername,
    headers: { "User-Agent": "HNBCRM-Leitor/1.0" },
    signal: new AbortController().signal,
  });

  it("SNI e Host pelo nome, lookup fixo no IP, sem agente compartilhado, TLS verificado", async () => {
    const o = buildRequestOptions(base("salao.com.br", "https://salao.com.br/a?b=1"));
    expect(o.hostname).toBe("salao.com.br");
    expect((o as { servername?: string }).servername).toBe("salao.com.br");
    expect(o.path).toBe("/a?b=1");
    expect(o.port).toBe(443);
    expect(o.agent).toBe(false);
    expect((o as { rejectUnauthorized?: boolean }).rejectUnauthorized).toBe(true);
    expect((o.headers as Record<string, string>).Host).toBe("salao.com.br");
    const r = await callLookup(o.lookup as unknown as ReturnType<typeof makePinnedLookup>, "salao.com.br", {});
    expect(r.addr).toBe("93.184.216.34");
  });

  it("IP literal não vai no SNI; porta explícita preservada", () => {
    const o = buildRequestOptions(base("8.8.8.8", "https://8.8.8.8:8443/x"));
    expect((o as { servername?: string }).servername).toBeUndefined();
    expect(o.port).toBe(8443);
  });
});

describe("decodedBody", () => {
  const text = "Tabela de preços: corte R$ 90,00";
  it.each([
    ["identity", Buffer.from(text)],
    ["gzip", gzipSync(text)],
    ["x-gzip", gzipSync(text)],
    ["deflate", deflateSync(text)],
    ["br", brotliCompressSync(text)],
  ])("%s", async (enc, data) => {
    expect(await readAll(decodedBody(enc, Readable.from([data])))).toBe(text);
  });

  it("content-encoding desconhecido é recusado", () => {
    expect(() => decodedBody("zstd", Readable.from([Buffer.from("x")]))).toThrow(UnsupportedEncodingError);
    expect(() => decodedBody("gzip, br", Readable.from([Buffer.from("x")]))).toThrow(UnsupportedEncodingError);
  });

  it("gzip corrompido: o erro propaga para a leitura (pipeline)", async () => {
    await expect(readAll(decodedBody("gzip", Readable.from([Buffer.from("isto não é gzip")])))).rejects.toThrow();
  });
});
