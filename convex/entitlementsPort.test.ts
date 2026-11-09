/**
 * Teste de BUILD da porta de entitlements (billing B1).
 *
 *  (a) Só `lib/entitlementsOps.ts` e `opsBilling.ts` escrevem `billing` em
 *      `organizations` e inserem em `orgSubscriptions`. Outro caminho deixa o
 *      plano (e o rastro de audit `high`) fora da porta de transição.
 *  (b) Convite de membro NUNCA importa entitlements: usuários ilimitados por contrato.
 *  (c) `exports.ts` NUNCA importa entitlements: exportação é sempre liberada.
 *
 * HEURÍSTICA (lê os fontes, sem AST): recorta cada `.patch(`/`.replace(`/
 * `.insert(` por parênteses balanceados.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const CONVEX_DIR = __dirname;
const PORT_FILES = new Set(["lib/entitlementsOps.ts", "opsBilling.ts"]);

function sliceBalanced(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return src.slice(openIdx);
}

/** Linhas de escritas que gravam `billing` numa org ou inserem em `orgSubscriptions`. */
export function findBillingWrites(src: string): number[] {
  const lines: number[] = [];
  const re = /\.(?:patch|replace|insert)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // `initialOrgBilling(now)` é o único valor de `billing` permitido no insert de organizations.
    const call = sliceBalanced(src, m.index + m[0].length - 1).replace(/\bbilling\s*:\s*initialOrgBilling\s*\([^)]*\)/g, "");
    const orgTarget = /"organizations"|\borganizationId\b|\borgId\b|\borg\._id\b/.test(call.split(",")[0] ?? "");
    const writesBilling = /\bbilling\b/.test(call) && orgTarget;
    const subscriptionInsert = /^\(\s*["']orgSubscriptions["']/.test(call);
    if (writesBilling || subscriptionInsert) lines.push(src.slice(0, m.index).split("\n").length);
  }
  return lines;
}

/** Corpo (aproximado) de `export const <name> = ` até o próximo `export `. */
function exportBody(src: string, name: string): string {
  const start = src.search(new RegExp(`export const ${name}\\b`));
  if (start < 0) return "";
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

const importsEntitlements = (src: string) => /from\s*["'][^"']*\/(?:lib\/)?(?:entitlements|entitlementsOps|plans)["']/.test(src);

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
const read = (file: string) => readFileSync(path.join(CONVEX_DIR, file), "utf8");

describe("heurística (auto-teste)", () => {
  test("pega patch de billing multi-linha e insert em orgSubscriptions", () => {
    expect(findBillingWrites(`await ctx.db.patch(args.organizationId, {\n  billing: next,\n});`)).toHaveLength(1);
    expect(findBillingWrites(`await ctx.db.patch(orgId, { settings: s, billing })`)).toHaveLength(1);
    expect(findBillingWrites(`await ctx.db.insert("orgSubscriptions", { organizationId })`)).toHaveLength(1);
    expect(findBillingWrites(`await ctx.db.insert("organizations", { name, billing: b })`)).toHaveLength(1);
    expect(findBillingWrites(`await ctx.db.insert("organizations", { name, billing: { status: "active" } })`)).toHaveLength(1);
  });

  test("permite só o helper initialOrgBilling no insert de organizations", () => {
    expect(findBillingWrites(`await ctx.db.insert("organizations", { name, billing: initialOrgBilling(now) })`)).toHaveLength(0);
  });

  test("não confunde outras escritas nem leituras", () => {
    expect(findBillingWrites(`await ctx.db.patch(args.organizationId, { settings: merged })`)).toHaveLength(0);
    expect(findBillingWrites(`await ctx.db.insert("auditLogs", { organizationId, metadata: { kind: "billing" } })`)).toHaveLength(0);
    expect(findBillingWrites(`await ctx.db.patch(lead._id, { billing: 1 })`)).toHaveLength(0);
    expect(findBillingWrites(`const s = await ctx.db.query("orgSubscriptions").first()`)).toHaveLength(0);
  });

  test("import de entitlements é detectado", () => {
    expect(importsEntitlements(`import { x } from "./lib/entitlements";`)).toBe(true);
    expect(importsEntitlements(`import { x } from "./lib/plans";`)).toBe(true);
    expect(importsEntitlements(`import { x } from "./lib/entitlementsOps";`)).toBe(true);
    expect(importsEntitlements(`import { x } from "./lib/auth";`)).toBe(false);
  });
});

describe("porta única de escrita do plano", () => {
  test("só lib/entitlementsOps.ts e opsBilling.ts escrevem billing/orgSubscriptions", () => {
    const violations: string[] = [];
    for (const abs of walk(CONVEX_DIR)) {
      const r = rel(abs);
      if (PORT_FILES.has(r)) continue;
      for (const line of findBillingWrites(readFileSync(abs, "utf8"))) violations.push(`${r}:${line}`);
    }
    expect(violations, "Grave o plano só por applySubscriptionChange (convex/lib/entitlementsOps.ts)").toEqual([]);
  });

  test("createOrganization grava legacy explícito pelo helper da porta", () => {
    const src = read("organizations.ts");
    expect(src).toMatch(/billing:\s*initialOrgBilling\(now\)/);
  });

  test("controle positivo: a porta é detectada pela heurística", () => {
    expect(findBillingWrites(read("lib/entitlementsOps.ts")).length).toBeGreaterThanOrEqual(2);
  });
});

describe("convites e exportação nunca têm gate de plano", () => {
  test("teamMembers.ts e o convite em nodeActions.ts não citam entitlements", () => {
    const team = read("teamMembers.ts");
    expect(importsEntitlements(team)).toBe(false);
    expect(team).not.toMatch(/\bresolveEntitlements\b|\bloadEntitlements\b|\bcheckChannelSlot\b|\bcheckModule\b|limits\./);
    const invite = exportBody(read("nodeActions.ts"), "inviteHumanMember");
    expect(invite.length, "inviteHumanMember deve existir em nodeActions.ts").toBeGreaterThan(0);
    expect(invite).not.toMatch(/entitlements|resolveEntitlements|loadEntitlements|limits\./);
  });

  test("exports.ts não importa entitlements", () => {
    const src = read("exports.ts");
    expect(importsEntitlements(src)).toBe(false);
    expect(src).not.toMatch(/resolveEntitlements|loadEntitlements/);
  });
});
