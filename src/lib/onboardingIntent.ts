/**
 * Mensagem que o visitante digitou no hero da landing (ou o chip que tocou),
 * guardada SÓ no navegador até a conversa de `/comecar` poder enviá-la como
 * primeiro turno, depois do login.
 *
 * Fonte única: quem grava é o hero (`goToOnboarding`/`saveOnboardingDraft` em
 * `src/lib/onboardingEntry.ts`: sessionStorage `hnbcrm:onboarding-rascunho`,
 * JSON `{message ≤ 2000, niche}`). Aqui só se lê pela mesma porta
 * (`readOnboardingDraft`, que revalida JSON e nicho) e se normaliza para a
 * conversa: texto aparado; nada aproveitável = null.
 */
import {
  ONBOARDING_DRAFT_KEY,
  ONBOARDING_DRAFT_MAX,
  clearOnboardingDraft,
  readOnboardingDraft,
  type OnboardingNiche,
} from "./onboardingEntry";

export const ONBOARDING_INTENT_STORAGE_KEY = ONBOARDING_DRAFT_KEY;
export const ONBOARDING_INTENT_MESSAGE_MAX = ONBOARDING_DRAFT_MAX;

export interface OnboardingIntent {
  /** Texto do visitante (aparado; vazio quando só tocou num nicho). */
  message: string;
  niche: OnboardingNiche | null;
}

export function readOnboardingIntent(): OnboardingIntent | null {
  const draft = readOnboardingDraft();
  if (!draft) return null;
  const message = draft.message.trim();
  if (!message && !draft.niche) return null;
  return { message, niche: draft.niche };
}

/** Depois de o primeiro turno COMEÇAR (ver `OnboardingConversationController`). */
export function clearOnboardingIntent(): void {
  clearOnboardingDraft();
}
