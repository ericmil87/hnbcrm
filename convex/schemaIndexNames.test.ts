import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// O Convex recusa o push de um índice com nome acima de 64 caracteres
// ("Identifiers must be 64 characters or less") e o convex-test não valida
// isso — um nome longo passa em toda a suíte e só quebra no deploy.
describe("nomes de índice do schema", () => {
  it("todos têm no máximo 64 caracteres e só letras, dígitos e _", () => {
    const src = readFileSync(fileURLToPath(new URL("./schema.ts", import.meta.url)), "utf8");
    const names = [...src.matchAll(/\.(?:index|searchIndex|vectorIndex)\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(50);
    const bad = names.filter((n) => n.length > 64 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(n));
    expect(bad).toEqual([]);
  });
});
