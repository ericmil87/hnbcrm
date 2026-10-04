import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

// `seed.ts` insere membros, leads, conversas e auditLogs em QUALQUER organizationId recebido.
// Até a v0.69.0 era `mutation` pública sem auth — qualquer cliente conseguia popular a org
// de outro cliente. Tem de continuar `internalMutation` (só CLI/dashboard).
describe("seed.ts não expõe função pública", () => {
  test("seedMockData é internalMutation e não há mutation/query/action pública", () => {
    const src = readFileSync("convex/seed.ts", "utf8");
    expect(src).toMatch(/export const seedMockData = internalMutation\(/);
    expect(src).not.toMatch(/(?<![A-Za-z])(mutation|query|action)\(\s*\{/);
    expect(src).not.toMatch(/import\s*\{[^}]*(?<![A-Za-z])(mutation|query|action)\b[^}]*\}\s*from "\.\/_generated\/server"/);
  });
});
