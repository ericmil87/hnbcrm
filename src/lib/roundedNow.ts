// "Agora" arredondado para baixo numa fronteira fixa do relógio. Usado em ARGS
// de query do Convex: cada valor novo de `now` cria uma assinatura nova (e uma
// execução completa da query), então ele só pode mudar a cada `stepMs`, e todos
// os componentes que usam o mesmo passo chegam ao MESMO valor — o cliente do
// Convex deduplica assinaturas com args idênticos.

export const DEFAULT_ROUNDED_NOW_STEP_MS = 15 * 60_000;

export function roundNow(nowMs: number, stepMs: number = DEFAULT_ROUNDED_NOW_STEP_MS): number {
  return Math.floor(nowMs / stepMs) * stepMs;
}

// Quanto falta até a próxima fronteira. Exatamente na fronteira, falta um passo
// inteiro (o valor arredondado acabou de mudar).
export function msUntilNextBoundary(
  nowMs: number,
  stepMs: number = DEFAULT_ROUNDED_NOW_STEP_MS
): number {
  return roundNow(nowMs, stepMs) + stepMs - nowMs;
}
