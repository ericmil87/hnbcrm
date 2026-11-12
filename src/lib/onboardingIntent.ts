/**
 * Mensagem que o visitante digitou no hero da landing (ou o chip que tocou),
 * guardada SÓ no navegador (sessionStorage, por aba) até a conversa de
 * `/comecar` poder enviá-la como primeiro turno, depois do login.
 *
 * QUEM GRAVA é o hero: `goToOnboarding(message, niche, navigate)` /
 * `saveOnboardingDraft` em `src/lib/onboardingEntry.ts` (P1.2). Este módulo só
 * LÊ, exatamente a mesma chave e o mesmo formato:
 *   sessionStorage["hnbcrm:onboarding-rascunho"] = JSON { message: string (≤ 2000), niche: string | null }
 * (`savedAt` opcional: se um dia vier, intenção com mais de 24 h é ignorada).
 * A leitura revalida tudo, porque o valor pode ter sido alterado fora do app.
 */

/** Mesma chave de `ONBOARDING_DRAFT_KEY` (`src/lib/onboardingEntry.ts`). */
export const ONBOARDING_INTENT_STORAGE_KEY = "hnbcrm:onboarding-rascunho";
/** Mesmo teto de `ONBOARDING_DRAFT_MAX` do hero. */
export const ONBOARDING_INTENT_MESSAGE_MAX = 2000;
/** Intenção mais velha que isto é ignorada (aba esquecida aberta). */
export const ONBOARDING_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

const NICHE_RE = /^[a-z0-9_-]{1,40}$/;

export interface OnboardingIntent {
  /** Texto do visitante (sem espaços nas pontas; pode ser vazio quando só tocou num nicho). */
  message: string;
  /** Id curto do nicho escolhido no hero (`imobiliaria`, `saude`…), ou null. */
  niche: string | null;
}

/** Normaliza e valida uma intenção crua; null quando não há nada aproveitável. */
export function parseOnboardingIntent(raw: unknown, now: number = Date.now()): OnboardingIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const message = typeof r.message === "string" ? r.message.trim().slice(0, ONBOARDING_INTENT_MESSAGE_MAX) : "";
  const niche = typeof r.niche === "string" && NICHE_RE.test(r.niche) ? r.niche : null;
  if (typeof r.savedAt === "number" && Number.isFinite(r.savedAt) && now - r.savedAt > ONBOARDING_INTENT_TTL_MS) {
    return null;
  }
  if (!message && !niche) return null;
  return { message, niche };
}

export function readOnboardingIntent(now: number = Date.now()): OnboardingIntent | null {
  try {
    const raw = sessionStorage.getItem(ONBOARDING_INTENT_STORAGE_KEY);
    if (!raw) return null;
    return parseOnboardingIntent(JSON.parse(raw), now);
  } catch {
    // Armazenamento indisponível ou JSON quebrado: a intenção é só conveniência.
    return null;
  }
}

export function clearOnboardingIntent(): void {
  try {
    sessionStorage.removeItem(ONBOARDING_INTENT_STORAGE_KEY);
  } catch {
    // Armazenamento indisponível: nada a limpar.
  }
}
