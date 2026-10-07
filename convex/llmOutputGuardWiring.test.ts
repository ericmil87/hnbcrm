/**
 * Teste de BUILD do guardrail de saída da IA (incidente de 07/10/2026: uma
 * chamada de ferramenta em formato nativo do modelo foi publicada como texto
 * em dois grupos). Garante que todo funil que publica texto do modelo passa
 * por `detectLeakedModelMarkup` — se alguém remover a fiação, o build quebra.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");
const IMPORT_RE = /import\s*\{[^}]*\bdetectLeakedModelMarkup\b[^}]*\}\s*from\s*["']\.{1,2}\/(?:lib\/)?llmOutputGuard["']/;
const usageCount = (src: string) => (src.match(/\bdetectLeakedModelMarkup\(/g) ?? []).length;

describe("guardrail de saída da IA — fiação (teste de build)", () => {
  test.each([
    // atendente 1 a 1: rodada, recuperação e trava final (+ helper da rodada)
    ["attendant.ts", 3],
    // publicação programada de grupo (bruto + limpo)
    ["groupPostWorker.ts", 2],
    // agente de grupo: o ponto de commit (motivo na run) …
    ["groupAgent.ts", 1],
    // … e o saneamento da resposta (defesa em profundidade)
    ["lib/groupAgentCore.ts", 1],
  ])("%s importa e usa detectLeakedModelMarkup", (file, minUses) => {
    const src = read(file);
    expect(IMPORT_RE.test(src), `${file} não importa detectLeakedModelMarkup`).toBe(true);
    expect(usageCount(src), `${file} usa o guard menos vezes que o esperado`).toBeGreaterThanOrEqual(
      minUses
    );
  });

  test("a publicação de grupo tem o aviso de 'sem ferramentas' na 2ª tentativa", () => {
    const src = read("groupPostWorker.ts");
    expect(src).toContain("GENERATE_NO_TOOLS_NUDGE");
  });

  test("o prompt da publicação proíbe chamada de ferramenta (REGRA 7)", () => {
    expect(read("lib/groupPostPrompt.ts")).toMatch(/7\. Nesta tarefa você NÃO tem ferramentas/);
  });
});
