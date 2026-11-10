/**
 * Teste de BUILD do adaptador único do Asaas. A chave do Asaas não tem escopo (acesso total à
 * conta), então SÓ `lib/asaasApi.ts` pode: citar o host do Asaas ou ler `ASAAS_API_KEY` /
 * `ASAAS_ENV` (o header `access_token` só existe lá porque só lá a chave é lida; `access_token`
 * também é nome de campo da Meta, por isso não é padrão deste guard). Os demais usam `isAsaasEnabled()` e as
 * funções do adaptador. `ASAAS_WEBHOOK_TOKEN` (segredo do webhook, não da API) só pode ser
 * lido pelo adaptador, pelo handler HTTP e por quem o repassa ao Asaas (ops).
 *
 * HEURÍSTICA (lê os fontes, sem AST; comentários removidos antes).
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const CONVEX_DIR = __dirname;
const ADAPTER = "lib/asaasApi.ts";
const WEBHOOK_TOKEN_READERS = new Set([ADAPTER, "billingHttp.ts"]);

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Linhas com o host do Asaas ou a chave/ambiente. */
export function findAsaasKeyAccess(src: string): number[] {
  const lines: number[] = [];
  stripComments(src)
    .split("\n")
    .forEach((line, i) => {
      if (/asaas\.com|ASAAS_API_KEY|ASAAS_ENV/.test(line)) lines.push(i + 1);
    });
  return lines;
}

export function findWebhookTokenAccess(src: string): number[] {
  const lines: number[] = [];
  stripComments(src)
    .split("\n")
    .forEach((line, i) => {
      if (/ASAAS_WEBHOOK_TOKEN/.test(line)) lines.push(i + 1);
    });
  return lines;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "_generated" || entry === "__fixtures__" || entry === "node_modules") continue;
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) acc.push(p);
  }
  return acc;
}

const rel = (abs: string) => path.relative(CONVEX_DIR, abs).split(path.sep).join("/");

describe("heurística (auto-teste)", () => {
  test("pega host, chave e ambiente", () => {
    expect(findAsaasKeyAccess(`fetch("https://api.asaas.com/v3/x")`)).toEqual([1]);
    expect(findAsaasKeyAccess(`const k = process.env.ASAAS_API_KEY;`)).toEqual([1]);
    expect(findAsaasKeyAccess(`process.env.ASAAS_ENV`)).toEqual([1]);
  });
  test("ignora comentários e o header do webhook", () => {
    expect(findAsaasKeyAccess(`// api.asaas.com\n/* ASAAS_API_KEY */\nconst h = "asaas-access-token";`)).toEqual([]);
    expect(findWebhookTokenAccess(`// ASAAS_WEBHOOK_TOKEN`)).toEqual([]);
    expect(findWebhookTokenAccess(`process.env.ASAAS_WEBHOOK_TOKEN`)).toEqual([1]);
  });
});

describe("adaptador único do Asaas", () => {
  const files = walk(CONVEX_DIR);

  test("só lib/asaasApi.ts cita o host, a chave ou o ambiente", () => {
    const violations: string[] = [];
    for (const abs of files) {
      const r = rel(abs);
      if (r === ADAPTER) continue;
      for (const line of findAsaasKeyAccess(readFileSync(abs, "utf8"))) violations.push(`${r}:${line}`);
    }
    expect(violations, "Fale com o Asaas só por convex/lib/asaasApi.ts").toEqual([]);
  });

  test("ASAAS_WEBHOOK_TOKEN só no adaptador e no handler HTTP", () => {
    const violations: string[] = [];
    for (const abs of files) {
      const r = rel(abs);
      if (WEBHOOK_TOKEN_READERS.has(r)) continue;
      for (const line of findWebhookTokenAccess(readFileSync(abs, "utf8"))) violations.push(`${r}:${line}`);
    }
    expect(violations).toEqual([]);
  });

  test("controle positivo: o adaptador é detectado", () => {
    expect(findAsaasKeyAccess(readFileSync(path.join(CONVEX_DIR, ADAPTER), "utf8")).length).toBeGreaterThanOrEqual(3);
  });

  test("o adaptador nunca loga (sem console.*)", () => {
    expect(stripComments(readFileSync(path.join(CONVEX_DIR, ADAPTER), "utf8"))).not.toMatch(/console\./);
  });
});
