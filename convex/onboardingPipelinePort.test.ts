// @vitest-environment node
/**
 * Guard de build do pipeline de IA do onboarding v2 (P2.3, plano 6.1):
 *  - leitor e entrevistador NUNCA recebem tools (nem o registro do Copiloto);
 *  - a IA nunca aplica: nenhum arquivo do pipeline chama a aplicação do rascunho;
 *    o rascunho só muda por `internalSaveDraft`;
 *  - toda chamada de LLM passa pela reserva e pelo registro de gasto do onboarding.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");
/** Código sem comentários (os comentários citam o que é proibido para explicar). */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const PIPELINE = ["lib/onboardingTurn.ts", "lib/onboardingInterviewer.ts", "onboardingChat.ts", "onboardingHttp.ts"];

describe("pipeline de IA do onboarding (teste de build)", () => {
  test.each(PIPELINE)("%s não usa tools nem o registro do Copiloto", (file) => {
    const src = code(file);
    expect(src).not.toMatch(/from\s+["'][./]*(?:lib\/)?agentTools["']/);
    expect(src).not.toMatch(/\btools\s*:/);
    expect(src).not.toMatch(/\btoolChoice\b|\btool_choice\b/);
    expect(src).not.toMatch(/COPILOT_(READ|WRITE)_TOOLS|toChatTools|runCopilotTurn|internalRunCopilotWriteTool/);
  });

  test.each(PIPELINE)("%s nunca aplica o rascunho", (file) => {
    const src = code(file);
    expect(src).not.toMatch(/applyOnboardingDraft|onboardingApply/);
  });

  test("o turno grava o rascunho só por internalSaveDraft e mede cada chamada", () => {
    const src = code("lib/onboardingTurn.ts");
    expect(src).toContain("internal.onboardingSessions.internalSaveDraft");
    expect(src).not.toMatch(/ctx\.db\b/);
    expect(src).toContain("internal.onboardingBudget.internalReserveOnboardingSpend");
    expect(src).toContain("internal.onboardingBudget.internalRecordOnboardingSpend");
    // Toda chamada ao provedor sai de `callJsonModel` (reserva → chamada → registro); a visão é medida à parte.
    expect((src.match(/chatWithFallback\(/g) ?? []).length).toBe(1);
  });
});
