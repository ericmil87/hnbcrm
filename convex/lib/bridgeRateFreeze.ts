/**
 * Congelamento do canal para envio AUTOMÁTICO EM VOLUME (campanhas e
 * publicações agendadas em grupo) quando o gateway bridge devolve
 * `rate_limited` (`429 rate-overlimit`). PURO: nada aqui toca o banco.
 *
 * Reaproveita `channelPacing.campaignFrozenUntil` (o mesmo congelamento da
 * 131048 da Meta): o worker de campanhas e o de publicações de grupo já
 * adiam, sem pausar nem descartar, enquanto ele estiver no futuro. Esta
 * política só decide POR QUANTO TEMPO, com duração crescente na reincidência.
 *
 * Os números são ESTIMATIVAS conservadoras, não limites oficiais do WhatsApp
 * (que não publica o limite do `rate-overlimit`): começa em poucos minutos
 * (o inbound humano e o atendente seguem normalmente, só o volume espera),
 * dobra a cada reincidência e para em 1 h; depois de um período limpo volta
 * ao começo. Ideia de backoff crescente, calibrável com dados de PROD.
 */

/** 1ª ocorrência: campanhas/posts do canal esperam 5 min. */
export const BRIDGE_RATE_FREEZE_BASE_MS = 5 * 60 * 1000;
/** Teto da duração: 1 h (uma campanha atrasada, nunca perdida). */
export const BRIDGE_RATE_FREEZE_MAX_MS = 60 * 60 * 1000;
/** Fator de crescimento por reincidência. */
export const BRIDGE_RATE_FREEZE_FACTOR = 2;
/** Período limpo (sem novo rate limit desde a última ocorrência) que zera o contador. */
export const BRIDGE_RATE_FREEZE_RESET_MS = 6 * 60 * 60 * 1000;

export type BridgeRateLimitState = { strikes: number; lastAt: number };

export type BridgeRateFreezePlan = {
  /** Estado a gravar em `channelPacing.bridgeRateLimit`. */
  state: BridgeRateLimitState;
  /** Quanto tempo o congelamento dura a partir de `now`. */
  durationMs: number;
  /** `now + durationMs`. */
  until: number;
  /** false = o canal já estava congelado (mesmo incidente): não escalou nem estendeu. */
  escalated: boolean;
};

/** Duração da N-ésima ocorrência seguida (N >= 1), com teto. */
export function bridgeRateFreezeDuration(strikes: number): number {
  const n = Math.max(1, Math.floor(strikes));
  const ms = BRIDGE_RATE_FREEZE_BASE_MS * Math.pow(BRIDGE_RATE_FREEZE_FACTOR, n - 1);
  return Math.min(ms, BRIDGE_RATE_FREEZE_MAX_MS);
}

/**
 * Próximo congelamento. Se o canal JÁ está congelado (`frozenUntil > now`) o
 * erro é do mesmo incidente (várias mensagens em voo falham juntas): devolve
 * `escalated:false` e mantém o estado, sem dobrar a duração por rajada.
 */
export function planBridgeRateFreeze(args: {
  prev: BridgeRateLimitState | undefined;
  frozenUntil: number | undefined;
  now: number;
}): BridgeRateFreezePlan {
  const { prev, frozenUntil, now } = args;
  if (frozenUntil !== undefined && frozenUntil > now) {
    const state = prev ?? { strikes: 1, lastAt: now };
    return { state, durationMs: frozenUntil - now, until: frozenUntil, escalated: false };
  }
  const clean = !prev || now - prev.lastAt >= BRIDGE_RATE_FREEZE_RESET_MS;
  const strikes = clean ? 1 : prev.strikes + 1;
  const durationMs = bridgeRateFreezeDuration(strikes);
  return { state: { strikes, lastAt: now }, durationMs, until: now + durationMs, escalated: true };
}
