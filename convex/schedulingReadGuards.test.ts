// @vitest-environment node
/**
 * Agenda v2, A3a: guards de código-fonte. Query nunca usa `.filter()` do banco nem `Date.now()`; toda função
 * pública declara `args` + `returns` e começa pela checagem de acesso; só `schedRead`/portas tocam a tabela
 * de ocupação e nenhum arquivo daqui altera agendamento (regra que o PR A3b transforma em guard geral).
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
/** Remove comentários (a documentação cita `Date.now()` e `.filter()` de propósito). */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const READ_FILES = ["scheduling.ts", "lib/schedRead.ts", "lib/schedSearch.ts", "lib/schedViews.ts", "lib/schedTemplates.ts"];
const ALL_FILES = [...READ_FILES, "schedulingConfig.ts", "lib/schedConfigOps.ts"];
const DB_FILTER = /\.filter\(\s*\(?\s*q\s*[,):=]/;

describe("A3a: queries por índice e sem relógio", () => {
  test.each(ALL_FILES)("%s não usa .filter() do banco", (f) => {
    expect(code(f)).not.toMatch(DB_FILTER);
  });
  test.each(READ_FILES)("%s não usa Date.now() nem new Date()", (f) => {
    expect(code(f)).not.toMatch(/Date\.now\(\)|new Date\(\)/);
  });
  test("schedulingConfig.ts: Date.now() só nas mutations (depois do marcador de escrita)", () => {
    const src = read("schedulingConfig.ts");
    const writes = src.indexOf("// Escrita (agenda:manage");
    expect(writes).toBeGreaterThan(0);
    expect(src.indexOf("Date.now()")).toBeGreaterThan(writes);
  });
});

describe("A3a: toda função pública tem args, returns e checa o acesso primeiro", () => {
  test.each(["scheduling.ts", "schedulingConfig.ts"])("%s", (f) => {
    const parts = code(f).split(/\nexport const /).slice(1);
    const fns = parts.filter((p) => /^\w+ = (query|mutation)\(\{/.test(p));
    expect(fns.length).toBeGreaterThan(0);
    for (const p of fns) {
      const name = p.split(" ")[0];
      expect(p, `${name}: args`).toMatch(/\bargs:/);
      expect(p, `${name}: returns`).toMatch(/\breturns:/);
      expect(p, `${name}: acesso`).toMatch(/resolveAgendaReader|readerIfOn|gate\(ctx/);
    }
  });
  test("schedulingConfig.ts: mutations chamam gate() (requirePermission manage + assertModule) antes de qualquer escrita", () => {
    const src = code("schedulingConfig.ts");
    expect(src).toMatch(/requirePermission\(ctx, organizationId, "agenda", "manage"\)\s*;\s*await assertModule\(ctx, organizationId, "scheduling"\)/);
  });
});

describe("A3a: fronteiras das portas", () => {
  test("a tabela de ocupação só aparece em schedRead (leitura)", () => {
    for (const f of ALL_FILES.filter((x) => x !== "lib/schedRead.ts")) {
      expect(code(f), f).not.toContain('"schedAllocations"');
    }
  });
  test("nenhum arquivo desta fase altera ou insere agendamento", () => {
    for (const f of ALL_FILES) {
      const src = code(f);
      expect(src, f).not.toMatch(/insert\("schedAppointments"/);
      expect(src.includes('"schedAppointments"') && src.includes(".patch("), f).toBe(false);
    }
  });
  test("ids opcionais nunca consultam índice com undefined (relacionados só com valor definido)", () => {
    const src = code("scheduling.ts");
    expect(src).toMatch(/if \(contactId !== undefined\)/);
    expect(src).toMatch(/if \(leadId !== undefined\)/);
  });
});
