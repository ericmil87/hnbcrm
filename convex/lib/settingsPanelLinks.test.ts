// @vitest-environment node
/**
 * Build guard: todo `secao=<id>` literal emitido pelo backend (links de e-mail,
 * Telegram, Copiloto, OAuth) precisa existir no registro de Configurações do
 * frontend. Os ids legados (general, ai, apikeys...) também são painéis do
 * registro, então um único conjunto cobre tudo.
 */
import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const CONVEX_DIR = path.join(__dirname, "..");
const ROOT = path.join(CONVEX_DIR, "..");

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "_generated" || e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listTs(full));
    else if (e.name.endsWith(".ts") && !/\.test\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

const registry = readFileSync(path.join(ROOT, "src/components/settings/registry.ts"), "utf8");
const panelIds = new Set([...registry.matchAll(/\bid:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]));
// Painel "Uso e fatura" (front, PR #90) entra no mesmo lançamento; os avisos de plano já apontam para ele.
panelIds.add("billing");

describe("links ?secao= emitidos pelo backend", () => {
  test("o registro de painéis foi lido", () => {
    expect(panelIds.has("channels")).toBe(true);
    expect(panelIds.has("ai")).toBe(true);
  });

  test("todo id literal existe no registro", () => {
    const errors: string[] = [];
    let found = 0;
    for (const file of listTs(CONVEX_DIR)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/secao=([A-Za-z0-9_-]+)/g)) {
          found++;
          if (!panelIds.has(m[1])) {
            errors.push(`${path.relative(ROOT, file)}:${i + 1} — secao=${m[1]} não existe no registro`);
          }
        }
      });
    }
    expect(found).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});
