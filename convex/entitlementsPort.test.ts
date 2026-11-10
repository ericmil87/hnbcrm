/**
 * Teste de BUILD da porta de entitlements (billing B1).
 *
 *  (a) Só `lib/entitlementsOps.ts` e `opsBilling.ts` escrevem `billing` (qualquer
 *      patch/replace/insert que traga `billing`, em qualquer tabela) e só a porta
 *      cita a tabela `orgSubscriptions`.
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
// `aiAttendances.billing` é a CLASSE do atendimento (included/credit/...), não o plano da org:
// o livro grava essa coluna. O teste abaixo garante que ele não escreve em `organizations`.
const LEDGER_FILE = "lib/attendanceLedger.ts";
// Arquivos que podem CITAR a tabela `orgSubscriptions`: a porta, o schema, o `billing.ts`
// do B3 (só leitura) e as listas de classificação (purge LGPD e backup), que só a NOMEIAM.
const SUBSCRIPTION_FILES = new Set([
  "lib/entitlementsOps.ts",
  "schema.ts",
  "billing.ts",
  "opsPurge.ts",
  "lib/exportSanitize.ts",
  // Cobrança (Asaas): LÊ a assinatura (índice por id do provedor) e grava só pela porta.
  "billingAsaas.ts",
  // Cron do plano: só LÊ a assinatura para achar trava vencida (o repreço grava pela porta, em billingAsaas).
  "billingCron.ts",
  // Puro: só o TIPO `Doc<"orgSubscriptions">` (decide se há repreço; não toca no banco).
  "lib/lockExpiry.ts",
]);

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

/** Esvazia o conteúdo de strings (um `"billing"` em texto de audit não é a chave). */
function stripStrings(code: string): string {
  return code.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
}

/** O identificador foi montado com `billing` antes (declaração, `X.billing =` ou `X["billing"] =`)? */
function builtWithBilling(src: string, ident: string): boolean {
  const declared = new RegExp(`(?:const|let)\\s+${ident}\\b[^;]*?\\bbilling\\b`);
  const dot = new RegExp(`\\b${ident}\\.billing\\s*=`);
  const bracket = new RegExp(`\\b${ident}\\[\\s*["']billing["']\\s*\\]\\s*=`);
  return declared.test(src) || dot.test(src) || bracket.test(src);
}

/**
 * Linhas de escritas (`patch`/`replace`/`insert`) que gravam `billing` (chave, shorthand ou
 * objeto montado antes), sem exigir o nome do alvo, ou que inserem em `orgSubscriptions`.
 */
export function findBillingWrites(src: string): number[] {
  const lines: number[] = [];
  const re = /\.(?:patch|replace|insert)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const raw = sliceBalanced(src, m.index + m[0].length - 1);
    // `initialOrgBilling(now)` é o único valor de `billing` permitido no insert de organizations.
    const call = raw.replace(/\bbilling\s*:\s*initialOrgBilling\s*\([^)]*\)/g, "").replace(/\bbilling\s*:[^,]*\binitialTrialBilling\s*\([^)]*\)/g, "");
    const code = stripStrings(call);
    const direct = /\bbilling\b/.test(code);
    const second = /^\(\s*[^,()]+(?:\([^)]*\))?[^,()]*,\s*([A-Za-z_$][\w$]*)\s*\)$/.exec(code.trim());
    const indirect = second ? builtWithBilling(src.slice(0, m.index), second[1]) : false;
    const subscriptionInsert = /^\(\s*["']orgSubscriptions["']/.test(raw);
    if (direct || indirect || subscriptionInsert) lines.push(src.slice(0, m.index).split("\n").length);
  }
  return lines;
}

/** Linhas que citam a tabela `orgSubscriptions` (literal entre aspas). */
export function findSubscriptionCitations(src: string): number[] {
  const lines: number[] = [];
  src.split("\n").forEach((line, i) => {
    if (/["']orgSubscriptions["']/.test(line)) lines.push(i + 1);
  });
  return lines;
}

/** Linhas com `insert("<table>"` (escrita direta numa tabela de medição). */
export function findTableInserts(src: string, table: string): number[] {
  const lines: number[] = [];
  const re = new RegExp(`\\.insert\\s*\\(\\s*["']${table}["']`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) lines.push(src.slice(0, m.index).split("\n").length);
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

  test("pega shorthand sem nome de alvo e objeto montado antes", () => {
    expect(findBillingWrites(`await ctx.db.patch(o._id, { billing })`)).toHaveLength(1);
    expect(findBillingWrites(`await ctx.db.replace(doc._id, { ...doc, billing: next })`)).toHaveLength(1);
    expect(findBillingWrites(`const patchObj = { name, billing: x };\nawait ctx.db.patch(id, patchObj);`)).toHaveLength(1);
    expect(findBillingWrites(`const upd: any = {};\nupd["billing"] = b;\nawait ctx.db.patch(id, upd);`)).toHaveLength(1);
    expect(findBillingWrites(`const upd = { name };\nawait ctx.db.patch(id, upd);`)).toHaveLength(0);
  });

  test("permite só o helper initialOrgBilling no insert de organizations", () => {
    expect(findBillingWrites(`await ctx.db.insert("organizations", { name, billing: initialOrgBilling(now) })`)).toHaveLength(0);
  });

  test("não confunde outras escritas nem leituras", () => {
    expect(findBillingWrites(`await ctx.db.patch(args.organizationId, { settings: merged })`)).toHaveLength(0);
    expect(findBillingWrites(`await ctx.db.insert("auditLogs", { organizationId, metadata: { kind: "billing" } })`)).toHaveLength(0);
    expect(findBillingWrites(`const s = await ctx.db.query("orgSubscriptions").first()`)).toHaveLength(0);
  });

  test("citação da tabela orgSubscriptions é detectada", () => {
    expect(findSubscriptionCitations(`await ctx.db.query("orgSubscriptions").first()`)).toEqual([1]);
    expect(findSubscriptionCitations(`const x = "orgSubscriptionsX"`)).toEqual([]);
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
      if (PORT_FILES.has(r) || r === LEDGER_FILE) continue;
      for (const line of findBillingWrites(readFileSync(abs, "utf8"))) violations.push(`${r}:${line}`);
    }
    expect(violations, "Grave o plano só por applySubscriptionChange (convex/lib/entitlementsOps.ts)").toEqual([]);
  });

  test("o livro (attendanceLedger) só escreve em aiAttendances e orgUsageMonthly, nunca na org", () => {
    const src = read(LEDGER_FILE);
    expect(src).not.toMatch(/\.(?:patch|replace)\s*\(\s*[\w.]*organizationId\b/);
    expect(src).not.toMatch(/insert\(\s*["']organizations["']/);
  });

  test("só a porta (schema e billing.ts de leitura) cita a tabela orgSubscriptions", () => {
    const violations: string[] = [];
    for (const abs of walk(CONVEX_DIR)) {
      const r = rel(abs);
      if (SUBSCRIPTION_FILES.has(r)) continue;
      for (const line of findSubscriptionCitations(readFileSync(abs, "utf8"))) violations.push(`${r}:${line}`);
    }
    expect(violations, "orgSubscriptions só é escrita por lib/entitlementsOps.ts").toEqual([]);
  });

  test('audit:"none" só no backfill (opsBilling), no nível de uso (billingNotify), no carimbo do cron (billingCron), nas renovações do Asaas (billingAsaas) e na própria porta', () => {
    const offenders: string[] = [];
    for (const abs of walk(CONVEX_DIR)) {
      const r = rel(abs);
      if (PORT_FILES.has(r) || r === "lib/billingNotify.ts" || r === "billingCron.ts" || r === "billingAsaas.ts") continue;
      if (/audit:\s*["']none["']/.test(readFileSync(abs, "utf8"))) offenders.push(r);
    }
    expect(offenders).toEqual([]);
  });

  test("tabelas de billing entram na purge LGPD e fora do backup", () => {
    const purge = read("opsPurge.ts");
    const sanitize = read("lib/exportSanitize.ts");
    for (const table of ["orgSubscriptions", "usageCredits", "aiAttendances", "orgUsageMonthly"]) {
      expect(purge).toContain(`table: "${table}"`);
      expect(sanitize).toContain(`"${table}"`);
    }
    expect(sanitize).toContain('"organizations.billing"');
  });

  test("billing.ts (queries de uso e setOverage) não escreve direto: tudo passa pela porta", () => {
    const src = read("billing.ts");
    expect(src).not.toMatch(/\.(?:patch|replace|insert|delete)\s*\(/);
    expect(src).toContain("applySubscriptionChange(");
  });

  test("createOrganization grava legacy explícito pelo helper da porta", () => {
    const src = read("organizations.ts");
    expect(src).toMatch(/initialOrgBilling\(now\)/);
    expect(src).toMatch(/initialTrialBilling\(now, trialEndsAt\)/);
  });

  test("controle positivo: a porta é detectada pela heurística", () => {
    expect(findBillingWrites(read("lib/entitlementsOps.ts")).length).toBeGreaterThanOrEqual(2);
  });
});

describe("medição: portas únicas de escrita (B2)", () => {
  // Quem pode inserir em cada tabela de medição. `orgUsageMonthly` tem dois donos: o
  // medidor de envios (usageMeter) e o livro de atendimentos (attendanceLedger), que mantém
  // os contadores de IA lá para não disputar o doc de custo (`aiUsageMonthly`).
  const OWNERS: Array<[table: string, owners: string[]]> = [
    ["aiAttendances", ["lib/attendanceLedger.ts"]],
    ["orgUsageMonthly", ["lib/usageMeter.ts", "lib/attendanceLedger.ts"]],
    // B7a: só o cadastro concede teste (1 por usuário).
    ["trialGrants", ["organizations.ts"]],
  ];

  test("auto-teste da heurística", () => {
    expect(findTableInserts(`await ctx.db.insert("aiAttendances", { a: 1 })`, "aiAttendances")).toHaveLength(1);
    expect(findTableInserts(`await ctx.db.insert(\n  'orgUsageMonthly',\n {})`, "orgUsageMonthly")).toHaveLength(1);
    expect(findTableInserts(`await ctx.db.insert("auditLogs", {})`, "aiAttendances")).toHaveLength(0);
  });

  for (const [table, owners] of OWNERS) {
    test(`só ${owners.join(" e ")} inserem em ${table}`, () => {
      const violations: string[] = [];
      for (const abs of walk(CONVEX_DIR)) {
        const r = rel(abs);
        if (owners.includes(r)) continue;
        for (const line of findTableInserts(readFileSync(abs, "utf8"), table)) violations.push(`${r}:${line}`);
      }
      expect(violations).toEqual([]);
      for (const owner of owners) expect(findTableInserts(read(owner), table).length).toBeGreaterThanOrEqual(1);
    });
  }

  test("o commit do atendente não escreve em aiUsageMonthly (doc quente do custo)", () => {
    const src = read("lib/attendanceLedger.ts");
    expect(src).not.toMatch(/\.(?:query|insert)\(\s*["']aiUsageMonthly["']/);
  });
});

describe("termsAcceptances é append-only (7b)", () => {
  test("só convex/terms.ts insere e ninguém atualiza ou apaga a tabela", () => {
    const violations: string[] = [];
    for (const abs of walk(CONVEX_DIR)) {
      const r = rel(abs);
      const src = readFileSync(abs, "utf8");
      if (r !== "terms.ts") for (const line of findTableInserts(src, "termsAcceptances")) violations.push(`${r}:${line}`);
      if (/termsAcceptances/.test(src) && /\.(?:patch|replace|delete)\s*\(/.test(src) && r !== "schema.ts" && r !== "lib/exportSanitize.ts") {
        // Um arquivo que cita a tabela não pode também alterar/apagar docs (heurística conservadora).
        violations.push(`${r}: cita termsAcceptances e usa patch/replace/delete`);
      }
    }
    expect(violations).toEqual([]);
    expect(findTableInserts(read("terms.ts"), "termsAcceptances").length).toBeGreaterThanOrEqual(1);
  });
});

describe("cron do plano (B7)", () => {
  test("crons.ts agenda internalBillingTick diariamente às 12:00 UTC", () => {
    const src = read("crons.ts");
    expect(src).toMatch(/crons\.daily\(\s*"billing trial tick",\s*\{\s*hourUTC:\s*12,\s*minuteUTC:\s*0\s*\},\s*internal\.billingCron\.internalBillingTick/);
  });

  test("o cron só age em orgs trial (nunca troca active/past_due/legacy/canceled)", () => {
    const src = read("billingCron.ts");
    expect(src).toMatch(/billing\.status !== "trial"/);
    expect(src).not.toMatch(/status:\s*"(active|past_due|legacy|canceled)"/);
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
