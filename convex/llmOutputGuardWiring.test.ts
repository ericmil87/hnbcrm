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
    // tradução automática: saída do LLM (texto do JSON e resposta crua)
    ["lib/translationCore.ts", 2],
    // onboarding v2 (P2.3): reply/notas/chips do entrevistador (campo e resposta inteira)
    ["lib/onboardingInterviewer.ts", 2],
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

  // Meta Messaging F3: a saída por canal (`formatReplyForTransport`, que
  // escolhe `toWhatsAppText` ou `toPlainChatText`) é o ÚNICO formatador do
  // texto da IA no atendente, e fica DEPOIS do guard nos dois pontos de saída.
  test("atendente: formatação por canal só depois do detectLeakedModelMarkup (runtime e simulador)", () => {
    const src = read("attendant.ts");
    const helper = src.slice(src.indexOf("export function formatReplyForTransport"));
    expect(helper.slice(0, 600)).toMatch(/toPlainChatText\(text\)/);
    expect(helper.slice(0, 600)).toMatch(/toWhatsAppText\(text\)/);

    // Ninguém formata o texto da IA por fora do helper.
    expect(src).not.toMatch(/toWhatsAppText\(reply/);
    expect(src).not.toMatch(/toPlainChatText\(reply/);

    // Runtime: trava final do guard → formatação → commit.
    const finalGuard = src.indexOf("const finalLeak = detectLeakedModelMarkup(replyText)");
    const runtimeFormat = src.indexOf("replyText = formatReplyForTransport(replyText");
    const commitBase = src.indexOf("const commitArgsBase = {");
    expect(finalGuard).toBeGreaterThan(-1);
    expect(runtimeFormat).toBeGreaterThan(finalGuard);
    expect(commitBase).toBeGreaterThan(runtimeFormat);

    // Simulador: o guard da rodada vem antes da formatação devolvida.
    const sim = src.slice(src.indexOf("export const simulateAttendant"));
    const simGuard = sim.indexOf("leakInOutgoingRound(");
    const simFormat = sim.indexOf("formatReplyForTransport(reply, simulatedTransport)");
    expect(simGuard).toBeGreaterThan(-1);
    expect(simFormat).toBeGreaterThan(simGuard);
  });

  // Agenda v2 (D1): `schedClaimGuard` — a IA não pode AFIRMAR horário marcado/confirmado sem reserva. Mesmo funil do
  // vazamento: descarta a rodada, uma nova tentativa, depois falha; vale no runtime E no simulador.
  test("atendente: schedClaimGuard ligado no funil (rodada, trava final e simulador), depois do guard de vazamento", () => {
    const src = read("attendant.ts");
    expect(/import\s*\{[^}]*\bdetectUnbackedBookingClaim\b[^}]*\}\s*from\s*["']\.\/lib\/schedClaimGuard["']/.test(src)).toBe(true);
    // rodada (runtime e simulador) por `claimInOutgoingRound`; trava final (runtime e simulador) direto
    expect((src.match(/\bclaimInOutgoingRound\(/g) ?? []).length).toBeGreaterThanOrEqual(3); // definição + runtime + simulador
    expect((src.match(/\bdetectUnbackedBookingClaim\(/g) ?? []).length).toBeGreaterThanOrEqual(3); // helper + trava final + simulador

    // Runtime: o guard de afirmação vem DEPOIS do de vazamento na rodada e a trava final antes da formatação por canal.
    const runtime = src.slice(src.indexOf("export const internalProcessQueueItem"), src.indexOf("export const simulateAttendant"));
    const leakRound = runtime.indexOf("leakInOutgoingRound(");
    const claimRound = runtime.indexOf("claimInOutgoingRound(");
    expect(leakRound).toBeGreaterThan(-1);
    expect(claimRound).toBeGreaterThan(leakRound);
    const finalLeak = runtime.indexOf("const finalLeak = detectLeakedModelMarkup(replyText)");
    const finalClaim = runtime.indexOf("detectUnbackedBookingClaim(replyText");
    const format = runtime.indexOf("replyText = formatReplyForTransport(replyText");
    expect(finalClaim).toBeGreaterThan(finalLeak);
    expect(format).toBeGreaterThan(finalClaim);

    // Liga com o MÓDULO de agendamento (não com as tools: o turno de follow-up não tem tools e não pode afirmar marcação).
    expect(runtime.slice(claimRound - 400, claimRound)).toMatch(/schedGuardOn/);
    expect(runtime).toMatch(/const schedGuardOn = context\.schedulingOn === true/);

    // Simulador: o guard da rodada e a trava final vêm antes da formatação devolvida.
    const sim = src.slice(src.indexOf("export const simulateAttendant"));
    expect(sim.indexOf("claimInOutgoingRound(")).toBeGreaterThan(sim.indexOf("leakInOutgoingRound("));
    expect(sim.indexOf("detectUnbackedBookingClaim(reply")).toBeLessThan(sim.indexOf("formatReplyForTransport(reply, simulatedTransport)"));
  });

  test("a regra de afirmação é pura e fica fora do funil de vazamento (sem imports de servidor)", () => {
    const guard = read("lib/schedClaimGuard.ts");
    expect(guard).not.toMatch(/from\s+["']\.\.?\/_generated/);
    expect(guard).not.toMatch(/Date\.now\(/);
  });

  // Agenda v2 (D1): com o módulo de agenda DESLIGADO, commit e aprovação não leem nada a mais (marcar ofertas como mostradas).
  test("markOffersShownFromText só roda com o módulo ligado (commit: arg do claim; aprovação: aiDraft.schedulingOn)", () => {
    const src = read("attendant.ts");
    expect(src).toMatch(/if \(args\.schedulingOn === true\) \{\s*await markOffersShownFromText\(/);
    expect(src).toMatch(/\(aiDraft as \{ schedulingOn\?: boolean \}\)\.schedulingOn === true\) \{\s*await markOffersShownFromText\(/);
    expect((src.match(/markOffersShownFromText\(/g) ?? []).length).toBe(2);
    expect(src).toMatch(/\.\.\.\(context\.schedulingOn === true \? \{ schedulingOn: true \} : \{\}\)/);
  });

  test("o prompt manda remarcar/cancelar para repasse e o guard barra a afirmação de remarcação (`reschedule_claim`)", () => {
    expect(read("lib/schedAttendantTools.ts")).toMatch(/REMARCAR ou CANCELAR[^"']*requestHandoff/);
    expect(read("lib/schedClaimGuard.ts")).toContain('"reschedule_claim"');
  });
});
