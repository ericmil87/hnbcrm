// @vitest-environment node
/**
 * Guard de build do MCP da Agenda v2 (I1). O `mcp-server/` tem `node_modules` próprio (o CI instala só a raiz), então este
 * teste LÊ o fonte das tools em vez de importá-las: cada tool aponta para uma rota que existe (método e caminho) em
 * `ROUTE_PERMISSIONS`, cada rota `/scheduling` e as de `calendar/events/{complete,cancel}` têm tool, os nomes seguem o
 * padrão e são únicos, a contagem documentada bate, e as descrições carregam as regras que o agente precisa saber.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { ROUTE_PERMISSIONS } from "./router";

const ROOT = path.join(__dirname, "..");
const TOOLS_DIR = path.join(ROOT, "mcp-server/src/tools");
const read = (p: string) => readFileSync(p, "utf8");

type Tool = { name: string; file: string; block: string; calls: Array<{ method: "GET" | "POST" | "PUT"; path: string }> };

function parseTools(): Tool[] {
  const out: Tool[] = [];
  for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts"))) {
    const src = read(path.join(TOOLS_DIR, file));
    const starts = [...src.matchAll(/server\.tool\(\s*"([a-z_]+)"/g)];
    starts.forEach((m, i) => {
      const block = src.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index : src.length);
      const calls = [...block.matchAll(/client\.(get|post|put)\(\s*"(\/api\/v1\/[^"]+)"/g)].map((c) => ({
        method: c[1].toUpperCase() as "GET" | "POST" | "PUT",
        path: c[2],
      }));
      out.push({ name: m[1], file, block, calls });
    });
  }
  return out;
}
const TOOLS = parseTools();
const byName = (n: string) => TOOLS.find((t) => t.name === n)!;

const SCHEDULING_TOOLS = [
  "crm_list_scheduling_services",
  "crm_list_scheduling_resources",
  "crm_find_slots",
  "crm_list_agenda",
  "crm_get_appointment",
  "crm_list_scheduling_pending",
  "crm_preview_appointment",
  "crm_book_appointment",
  "crm_reschedule_appointment",
  "crm_cancel_appointment",
  "crm_set_appointment_status",
  "crm_undo_appointment_status",
  "crm_change_appointment_resources",
  "crm_close_resource",
  "crm_reopen_resource",
  "crm_get_closure_run",
  "crm_resolve_conflict",
];

describe("MCP da agenda", () => {
  test("o extrator achou as tools (sanidade) e os nomes são únicos", () => {
    expect(TOOLS.length).toBeGreaterThan(80);
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("tools de agenda: as 17 esperadas, no padrão crm_*, no arquivo scheduling.ts e registradas no índice", () => {
    const inFile = TOOLS.filter((t) => t.file === "scheduling.ts").map((t) => t.name);
    expect(inFile.sort()).toEqual([...SCHEDULING_TOOLS].sort());
    const index = read(path.join(ROOT, "mcp-server/src/index.ts"));
    expect(index).toContain('import { registerSchedulingTools } from "./tools/scheduling.js"');
    expect(index).toContain("registerSchedulingTools(server, client)");
  });

  test("toda tool de agenda chama uma rota que existe, com o mesmo método", () => {
    for (const t of TOOLS.filter((x) => x.file === "scheduling.ts" || x.name === "calendar_complete_event" || x.name === "calendar_cancel_event")) {
      expect(t.calls.length, t.name).toBeGreaterThan(0);
      for (const c of t.calls) expect(ROUTE_PERMISSIONS[`${c.method} ${c.path}`], `${t.name} → ${c.method} ${c.path}`).toBeDefined();
    }
  });

  test("toda rota /scheduling tem tool (cobertura), e as duas do calendário que faltavam existem", () => {
    const covered = new Set(TOOLS.flatMap((t) => t.calls.map((c) => `${c.method} ${c.path}`)));
    const missing = Object.keys(ROUTE_PERMISSIONS).filter((k) => k.includes("/api/v1/scheduling/") && !covered.has(k));
    expect(missing).toEqual([]);
    expect(covered.has("POST /api/v1/calendar/events/complete")).toBe(true);
    expect(covered.has("POST /api/v1/calendar/events/cancel")).toBe(true);
  });

  test("as descrições dizem ao agente o que ele precisa saber", () => {
    expect(byName("crm_find_slots").block).toMatch(/never invent/i);
    expect(byName("crm_preview_appointment").block).toMatch(/ALWAYS call this before crm_book_appointment/);
    const book = byName("crm_book_appointment").block;
    expect(book).toMatch(/idempotencyKey` is REQUIRED/);
    expect(book).toMatch(/409/);
    expect(book).toMatch(/alternatives/);
    expect(book).toMatch(/never force a block code/);
    // a chave é obrigatória no schema (sem .optional()) e vai como requestId
    expect(book).toMatch(/idempotencyKey: z\s*\.string\(\)\s*\.min\(1\)/);
    expect(book).not.toMatch(/idempotencyKey: z[\s\S]{0,200}\.optional\(\)\s*\.describe\("Required/);
    expect(book).toContain("requestId: idempotencyKey");
    expect(byName("crm_close_resource").block).toMatch(/preview/);
    expect(byName("crm_close_resource").block).toMatch(/expectedAffected/);
    // a data de entrada é LOCAL e a descrição manda usar o horário devolvido pela busca
    const src = read(path.join(TOOLS_DIR, "scheduling.ts"));
    expect(src).toMatch(/startsAtLocal: localTime\(/);
    expect(src).toMatch(/never invent one/);
  });

  test("o 409 volta ao agente com violations e alternatives (schedulingError)", () => {
    const src = read(path.join(TOOLS_DIR, "scheduling.ts"));
    expect(src).toMatch(/error\.status === 409/);
    expect(src).toMatch(/"sched_rules"/);
    expect(src).toMatch(/"idempotency_key_reused"/);
    expect(src).toMatch(/\.\.\.error\.body/);
  });

  test("a contagem documentada (README, llms, skill, package.json) bate com as tools registradas", () => {
    const total = TOOLS.length;
    expect(read(path.join(ROOT, "mcp-server/README.md"))).toContain(`**${total} tools across 12 categories**`);
    expect(read(path.join(ROOT, "mcp-server/package.json"))).toContain(`${total} tools to manage`);
    const llms = read(path.join(__dirname, "llmsTxt.ts"));
    expect(llms).toContain(`(${total} tools for AI agents)`);
    expect(llms).toContain(`exposes ${total} tools for AI agents`);
    for (const name of [...SCHEDULING_TOOLS, "calendar_complete_event", "calendar_cancel_event"]) {
      expect(llms, `llms sem ${name}`).toContain(name);
      expect(read(path.join(ROOT, ".claude/skills/hnbcrm/SKILL.md")), `skill sem ${name}`).toContain(name);
      expect(read(path.join(ROOT, "mcp-server/README.md")), `README sem ${name}`).toContain(name);
    }
  });

  test("versão do pacote e do servidor andam juntas", () => {
    const pkg = JSON.parse(read(path.join(ROOT, "mcp-server/package.json")));
    expect(read(path.join(ROOT, "mcp-server/src/index.ts"))).toContain(`version: "${pkg.version}"`);
  });
});
