/**
 * Cena do funil do onboarding (leads de EXEMPLO andando pelas etapas). PURO.
 * Cada lead `j` entra no tick `j` e anda até a etapa `n - 1 - j`; no último
 * tick (estado final, o que aparece com movimento reduzido) cada lead está
 * numa etapa diferente, nunca duas na mesma.
 */
import { exampleLeads } from "../../convex/lib/onboardingBlocks";

export interface SceneLead {
  name: string;
  note: string;
}

/** Leads da animação: os do servidor (`examples`) ou um padrão seguro (mensagens antigas não os trazem). */
export function sceneLeads(examples: unknown, stageCount: number): SceneLead[] {
  const valid = Array.isArray(examples)
    ? examples.filter(
        (e): e is SceneLead => !!e && typeof (e as SceneLead).name === "string" && typeof (e as SceneLead).note === "string" && !!(e as SceneLead).name.trim()
      )
    : [];
  const list = valid.length > 0 ? valid : exampleLeads(null);
  return list.slice(0, Math.max(1, Math.min(4, stageCount)));
}

export interface LeadPosition {
  /** Já entrou no funil neste tick. */
  visible: boolean;
  /** Etapa (0-based) em que está. */
  stage: number;
}

export function leadPositions(stageCount: number, leadCount: number, tick: number): LeadPosition[] {
  const n = Math.max(1, stageCount);
  return Array.from({ length: leadCount }, (_, j) => ({
    visible: tick >= j,
    stage: Math.max(0, Math.min(n - 1 - j, tick - j)),
  }));
}

/** Passos da cena: um por etapa; o último (estado final) fica mais tempo antes de repetir. */
export function sceneSteps(stageCount: number): Array<{ id: string; duration: number }> {
  const n = Math.max(1, stageCount);
  return Array.from({ length: n }, (_, i) => ({ id: `t${i}`, duration: i === n - 1 ? 3200 : 1100 }));
}
