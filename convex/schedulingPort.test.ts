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
 * `FUTURE_*` reserva arquivos que os PRs seguintes criam (A3a leitura, A3c exceções, A4 jobs, J1
 * ops): não precisam existir hoje, mas já estão autorizados com o motivo.
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
const ALLOC_NAME_FUTURE: Record<string, string> = {
  "lib/schedRead.ts": "A3a: leitura de disponibilidade por faixa (só leitura; nunca escreve)",
  "lib/schedExceptionOps.ts": "A3c: realocação ao fechar recurso, pela checagem da porta",
  "opsScheduling.ts": "J1: varredura de capacidade e reconstrução de alocações (dryRun)",
};

/** Regra 3: quem pode citar `"schedAppointments"` com patch/replace/delete no mesmo arquivo. */
const APPT_WRITE_ALLOWED: Record<string, string> = {
  [PORT]: "a porta única de reserva",
  "lib/leadCascade.ts": "excluir lead/contato zera leadId/contactId/contactName/guestName/notes/cancelReason do agendamento (LGPD), mantendo o histórico",
  "opsPurge.ts": "purga da org apaga os agendamentos (delete puro)",
  "exports.ts": "só LÊ os agendamentos para o backup (BACKUP_TABLES); os .patch do arquivo são de exportJobs/leads, nenhum em sched*",
};
const APPT_WRITE_FUTURE: Record<string, string> = {
  "lib/schedExceptionOps.ts": "A3c: realocar/marcar conflito ao fechar recurso (chama a checagem da porta)",
  "schedulingJobs.ts": "A4/F1: só outcomePendingSince e reminder (nunca status nem alocação)",
  "opsScheduling.ts": "J1: reconstrução de alocações e varredura (dryRun)",
};

const INSERT_RE = /\.insert\(\s*["'`]sched(?:Appointments|Allocations)["'`]/;
// Só aspas simples/duplas: comentários citam a tabela entre crases e não são acesso.
const ALLOC_NAME_RE = /["']schedAllocations["']/;
const APPT_NAME_RE = /["']schedAppointments["']/;
const WRITE_CALL_RE = /\.(?:patch|replace|delete)\s*\(/;

type Violation = { file: string; rule: 1 | 2 | 3; snippet: string };

function lineOf(src: string, idx: number): number {
  return src.slice(0, idx).split("\n").length;
}

export function findPortViolations(src: string, file: string): Violation[] {
  const out: Violation[] = [];
  const allowedInsert = file in INSERT_ALLOWED;
  const allowedAlloc = file in ALLOC_NAME_ALLOWED || file in ALLOC_NAME_FUTURE;
  const allowedWrite = file in APPT_WRITE_ALLOWED || file in APPT_WRITE_FUTURE;
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

  test("toda exceção vigente aponta para um arquivo que existe", () => {
    const existing = new Set(files.map(rel));
    for (const key of [...Object.keys(INSERT_ALLOWED), ...Object.keys(ALLOC_NAME_ALLOWED), ...Object.keys(APPT_WRITE_ALLOWED)]) {
      expect(existing.has(key), key).toBe(true);
    }
  });
});
