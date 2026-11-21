// @vitest-environment node
/**
 * Teste de BUILD da porta única de reserva (Agenda v2, A3b): só `lib/schedBookingOps.ts` insere,
 * altera ou apaga `schedAppointments` e `schedAllocations`. Um insert de alocação fora da função
 * `assertCapacityAndAllocate` é exatamente a marcação dupla que o desenho existe para impedir
 * (a checagem de capacidade e o insert têm de estar na MESMA mutation, lendo a mesma faixa).
 *
 * HEURÍSTICA (lê os fontes, sem AST; `ctx.db.patch(id, …)`/`delete(id)` não levam o nome da tabela,
 * por isso o critério é o nome da tabela no arquivo):
 *  1. `insert("schedAppointments"` / `insert("schedAllocations"` em qualquer arquivo fora da porta;
 *  2. a string `"schedAllocations"` (qualquer uso) fora da lista de quem a conhece por motivo;
 *  3. a string `"schedAppointments"` junto de `.patch(` / `.replace(` / `.delete(` no mesmo arquivo.
 * Tipos (`Id<"schedAppointments">`, `v.id("schedAppointments")`) sem patch/delete passam: o que
 * conta é escrever. Arquivo que só tipa a tabela e escreve em OUTRA tabela precisa entrar na lista
 * com o motivo (preferimos listar a afrouxar o padrão).
 *
 * Comentários são ignorados (`//` e bloco); crases contam como aspas (template literal).
 * LIMITE da heurística: nome de tabela montado em runtime (`"sched" + "Allocations"`) ou alias de
 * tipo importado de outro arquivo (`type A = Doc<…>` re-exportado) escapa; a revisão cobre isso.
 * Não há exceção reservada para arquivos que ainda não existem (A3c, A4, J1 incluem a sua).
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const CONVEX_DIR = __dirname;
const PORT = "lib/schedBookingOps.ts";

/** Regra 1: único arquivo que insere. */
const INSERT_ALLOWED: Record<string, string> = {
  [PORT]: "a porta única de reserva (assertCapacityAndAllocate e os cores)",
};

/** Regra 2: quem pode citar `"schedAllocations"`. */
const ALLOC_NAME_ALLOWED: Record<string, string> = {
  [PORT]: "a porta única de reserva",
  "schema.ts": "definição da tabela e do índice",
  "opsPurge.ts": "purga da org apaga as alocações do agendamento por by_appointment (delete puro, sem insert)",
  "lib/exportSanitize.ts": "lista EXCLUDED_BACKUP_TABLES (só o nome, nenhum acesso à tabela)",
};
/**
 * A3a (PR de leitura de disponibilidade) cita a tabela só para LER por faixa: autorizado a CITAR
 * (regra 2), nunca a escrever (não entra nas regras 1 e 3). Os demais arquivos futuros (A3c, A4, J1)
 * NÃO são reservados aqui: cada PR inclui a sua exceção, com justificativa, e a revisão a vê.
 */
const ALLOC_NAME_READ_ONLY: Record<string, string> = {
  "lib/schedRead.ts": "A3a: leitura de disponibilidade por faixa (só leitura; nunca escreve)",
  "lib/schedInvariants.test-helper.ts": "A3c: helper de TESTE que lê alocações para conferir invariantes (só leitura; nunca escreve)",
};

/** Regra 3: quem pode citar `"schedAppointments"` com patch/replace/delete no mesmo arquivo. */
const APPT_WRITE_ALLOWED: Record<string, string> = {
  [PORT]: "a porta única de reserva",
  "lib/leadCascade.ts": "excluir lead/contato zera leadId/contactId/contactName/guestName/notes/cancelReason do agendamento (LGPD), mantendo o histórico",
  "opsPurge.ts": "purga da org apaga os agendamentos (delete puro)",
  "exports.ts": "hoje só LÊ os agendamentos (BACKUP_TABLES, internalCollectPage); os .patch do arquivo são de exportJobs, nenhum em sched*. Escrever em sched* aqui reprova na revisão",
};
const INSERT_RE = /\.insert\(\s*["'`]sched(?:Appointments|Allocations)["'`]/;
const ALLOC_NAME_RE = /["'`]schedAllocations["'`]/;
const APPT_NAME_RE = /["'`]schedAppointments["'`]/;
const WRITE_CALL_RE = /\.(?:patch|replace|delete)\s*\(/;

type Violation = { file: string; rule: 1 | 2 | 3; snippet: string };

/** Troca comentários por espaços (preserva as linhas); `//` precisa vir no começo ou depois de espaço (não corta URL). */
export function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|\s)\/\/[^\n]*/g, (m, lead: string) => lead + " ".repeat(m.length - lead.length));
}

function lineOf(src: string, idx: number): number {
  return src.slice(0, idx).split("\n").length;
}

export function findPortViolations(rawSrc: string, file: string): Violation[] {
  const src = stripComments(rawSrc);
  const out: Violation[] = [];
  const allowedInsert = file in INSERT_ALLOWED;
  const allowedAlloc = file in ALLOC_NAME_ALLOWED || file in ALLOC_NAME_READ_ONLY;
  const allowedWrite = file in APPT_WRITE_ALLOWED;
  const insert = INSERT_RE.exec(src);
  if (insert && !allowedInsert) out.push({ file, rule: 1, snippet: `L${lineOf(src, insert.index)}: ${insert[0]}` });
  const alloc = ALLOC_NAME_RE.exec(src);
  if (alloc && !allowedAlloc) out.push({ file, rule: 2, snippet: `L${lineOf(src, alloc.index)}: ${alloc[0]}` });
  if (APPT_NAME_RE.test(src) && !allowedWrite) {
    const write = WRITE_CALL_RE.exec(src);
    if (write) out.push({ file, rule: 3, snippet: `L${lineOf(src, write.index)}: ${write[0]}` });
  }
  return out;
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

describe("heurística (auto-teste com arquivo de exemplo em memória)", () => {
  test("pega insert de alocação e de agendamento fora da porta", () => {
    expect(findPortViolations(`await ctx.db.insert("schedAllocations", { resourceId })`, "x.ts").map((v) => v.rule)).toContain(1);
    expect(findPortViolations(`await ctx.db.insert(\n  "schedAppointments",\n  doc)`, "x.ts").map((v) => v.rule)).toContain(1);
    expect(findPortViolations(`ctx.db.insert('schedAllocations', r)`, "x.ts")).not.toHaveLength(0);
  });

  test("pega qualquer uso do nome da tabela quente fora da lista", () => {
    expect(findPortViolations(`const t = "schedAllocations";`, "x.ts").map((v) => v.rule)).toContain(2);
    expect(findPortViolations(`ctx.db.query("schedAllocations").withIndex("by_appointment", q)`, "x.ts").map((v) => v.rule)).toContain(2);
  });

  test("pega patch, replace e delete num arquivo que cita schedAppointments", () => {
    expect(findPortViolations(`const a = await ctx.db.get(id as Id<"schedAppointments">); await ctx.db.patch(a._id, { status: "x" });`, "x.ts").map((v) => v.rule)).toContain(3);
    expect(findPortViolations(`type T = Doc<"schedAppointments">; await ctx.db.delete(row._id);`, "x.ts").map((v) => v.rule)).toContain(3);
    expect(findPortViolations(`v.id("schedAppointments"); await ctx.db.replace(id, doc)`, "x.ts").map((v) => v.rule)).toContain(3);
  });

  test("não acusa arquivo que só tipa a tabela, nem patch em arquivo sem a tabela", () => {
    expect(findPortViolations(`const id = v.id("schedAppointments"); const d = await ctx.db.get(x);`, "x.ts")).toEqual([]);
    expect(findPortViolations(`await ctx.db.patch(lead._id, { title })`, "x.ts")).toEqual([]);
  });

  test("pega crase (template literal) e ignora comentário", () => {
    expect(findPortViolations("const t = `schedAllocations`;", "x.ts").map((v) => v.rule)).toContain(2);
    expect(findPortViolations("await ctx.db.insert(`schedAppointments`, d)", "x.ts").map((v) => v.rule)).toContain(1);
    expect(findPortViolations("// usa `schedAllocations` só em comentário\n/* e `schedAppointments` .patch( aqui */\nconst x = 1;", "x.ts")).toEqual([]);
    expect(findPortViolations('const url = "https://x.test/y"; ctx.db.patch(a, b); v.id("schedAppointments")', "x.ts").map((v) => v.rule)).toContain(3);
  });

  test("lib/schedRead.ts pode CITAR a tabela, mas não escrever", () => {
    expect(findPortViolations(`ctx.db.query("schedAllocations")`, "lib/schedRead.ts")).toEqual([]);
    expect(findPortViolations(`ctx.db.insert("schedAllocations", r)`, "lib/schedRead.ts").map((v) => v.rule)).toEqual([1]);
    expect(findPortViolations(`const a = "schedAppointments"; ctx.db.patch(x, y)`, "lib/schedRead.ts").map((v) => v.rule)).toEqual([3]);
  });

  test("a porta e as exceções listadas passam", () => {
    const sample = `await ctx.db.insert("schedAllocations", r); ctx.db.patch(a._id, {}); const t = "schedAppointments";`;
    expect(findPortViolations(sample, PORT)).toEqual([]);
    expect(findPortViolations(`const t = "schedAllocations"; const a = "schedAppointments"; ctx.db.delete(x)`, "opsPurge.ts")).toEqual([]);
    expect(findPortViolations(`ctx.db.insert("schedAllocations", r)`, "opsPurge.ts").map((v) => v.rule)).toEqual([1]);
  });
});

describe("porta única de reserva", () => {
  const files = walk(CONVEX_DIR);

  test("nenhum insert/patch/delete de schedAppointments e schedAllocations fora da porta (e das exceções listadas)", () => {
    const violations: Violation[] = [];
    for (const abs of files) violations.push(...findPortViolations(readFileSync(abs, "utf8"), rel(abs)));
    expect(
      violations,
      "Escrita em schedAppointments/schedAllocations fora da porta única — use lib/schedBookingOps.ts (convex/lib/schedBookingOps.ts)"
    ).toEqual([]);
  });

  test("controle positivo: a porta é detectada pelas três regras", () => {
    const src = readFileSync(path.join(CONVEX_DIR, PORT), "utf8");
    expect(INSERT_RE.test(src)).toBe(true);
    expect(ALLOC_NAME_RE.test(src)).toBe(true);
    expect(APPT_NAME_RE.test(src) && WRITE_CALL_RE.test(src)).toBe(true);
  });

  test("só UM insert de alocação existe, dentro de assertCapacityAndAllocate", () => {
    const src = readFileSync(path.join(CONVEX_DIR, PORT), "utf8");
    const inserts = [...src.matchAll(/insert\(\s*["']schedAllocations["']/g)];
    expect(inserts).toHaveLength(1);
    const fnStart = src.indexOf("export async function assertCapacityAndAllocate(");
    const nextFn = src.indexOf("\n// ----", fnStart);
    expect(fnStart).toBeGreaterThan(0);
    expect(inserts[0].index!).toBeGreaterThan(fnStart);
    expect(inserts[0].index!).toBeLessThan(nextFn);
  });

  test("A3c: lib/schedExceptionOps.ts escreve só em schedExceptions/schedConflicts: não cita as tabelas quentes (tudo pela porta)", () => {
    // Sem exceção na lista (regras 1–3 já o reprovariam); este teste fixa a intenção e o motivo: fechar recurso
    // realoca/libera vaga por `planClosureRelocation`/`relocateAllocationCore`/`releaseAllocationForConflictCore`.
    const src = stripComments(readFileSync(path.join(CONVEX_DIR, "lib/schedExceptionOps.ts"), "utf8"));
    expect(ALLOC_NAME_RE.test(src)).toBe(false);
    expect(APPT_NAME_RE.test(src)).toBe(false);
    expect(findPortViolations(readFileSync(path.join(CONVEX_DIR, "lib/schedExceptionOps.ts"), "utf8"), "lib/schedExceptionOps.ts")).toEqual([]);
  });

  test("toda exceção vigente aponta para um arquivo que existe", () => {
    const existing = new Set(files.map(rel));
    for (const key of [...Object.keys(INSERT_ALLOWED), ...Object.keys(ALLOC_NAME_ALLOWED), ...Object.keys(APPT_WRITE_ALLOWED)]) {
      expect(existing.has(key), key).toBe(true);
    }
  });
});
