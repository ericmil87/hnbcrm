/**
 * Onboarding conversacional v2 (P2.4): modelo de cada papel, lido de env do
 * Convex (`npx convex env set`, sem deploy). Único ponto de leitura.
 *
 * Padrão = o que o `registry.ts` já valida em produção (mesmas constantes,
 * nenhuma string duplicada). Env vazia, com formato inválido ou fora do que o
 * registry conhece cai no padrão. Troca de modelo não muda o roteamento: a
 * trava de retenção zero e a ordem de provedores continuam sendo as de
 * `agentRoutes`/`registry`.
 */
import { DEFAULT_MODELS, MODEL_EQUIVALENCE, VISION_MODELS_BY_PROVIDER, registryModelIds } from "./llm/registry";
import { getTtsConfig } from "./tts";

export type OnboardingModelRole = "interviewer" | "reader" | "vision";

const ENV_BY_ROLE: Record<OnboardingModelRole, string> = {
  interviewer: "ONBOARDING_MODEL_INTERVIEWER",
  reader: "ONBOARDING_MODEL_READER",
  vision: "ONBOARDING_MODEL_VISION",
};

/** Entrevistador = Copiloto; leitor em quarentena = atendente; visão = passe de visão. */
export const ONBOARDING_DEFAULT_MODELS: Record<OnboardingModelRole, string> = {
  interviewer: DEFAULT_MODELS.copilot,
  reader: DEFAULT_MODELS.attendant,
  vision: DEFAULT_MODELS.vision,
};

const MODEL_ID_FORMAT = /^[A-Za-z0-9~][A-Za-z0-9._~:/-]{0,99}$/;

type EnvLike = Record<string, string | undefined>;

function knownIds(role: OnboardingModelRole): Set<string> {
  if (role === "vision") {
    // Visão tem allowlist própria por rota (fail-closed): só o que a cadeia de visão conhece.
    return new Set(Object.values(VISION_MODELS_BY_PROVIDER).flatMap((chain) => chain ?? []));
  }
  const ids = new Set<string>(registryModelIds());
  for (const perProvider of Object.values(MODEL_EQUIVALENCE)) {
    for (const id of Object.values(perProvider)) if (id) ids.add(id);
  }
  return ids;
}

export type OnboardingModelChoice = {
  model: string;
  source: "env" | "default";
  /** Env preenchida mas recusada (formato ou fora do registry): caiu no padrão. */
  rejected: boolean;
};

export function resolveOnboardingModel(role: OnboardingModelRole, env: EnvLike = process.env): OnboardingModelChoice {
  const fallback = ONBOARDING_DEFAULT_MODELS[role];
  const raw = env[ENV_BY_ROLE[role]]?.trim();
  if (!raw) return { model: fallback, source: "default", rejected: false };
  if (!MODEL_ID_FORMAT.test(raw) || !knownIds(role).has(raw)) {
    return { model: fallback, source: "default", rejected: true };
  }
  return { model: raw, source: "env", rejected: false };
}

export function getOnboardingModel(role: OnboardingModelRole, env: EnvLike = process.env): string {
  return resolveOnboardingModel(role, env).model;
}

/**
 * Voz do onboarding: mesma porta do atendente (`lib/tts.ts`, `getTtsConfig`).
 * Padrão = `google/gemini-3.8-flash-tts` + `Kore` (decisão do dono, P4.1);
 * `ONBOARDING_TTS_MODEL`/`ONBOARDING_TTS_VOICE` sobrescrevem quando estão na
 * lista da porta (modelo de PCM conhecido, voz de catálogo); fora dela, padrão.
 */
export function getOnboardingTts(env: EnvLike = process.env): { model: string; voice: string } {
  const { model, voice } = getTtsConfig("onboarding", env);
  return { model, voice };
}
