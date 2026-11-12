/**
 * Porta de entrada do onboarding conversacional a partir da landing (hero).
 * Guarda a mensagem do visitante só no navegador (sessionStorage, nunca vai a
 * servidor nenhum antes da conta) e leva para o destino. Quando a rota
 * `/comecar` existir (Onda 3), trocar `ONBOARDING_ROUTE_READY` para `true`:
 * é o único lugar a mudar.
 */
import { signUpHref } from "./authEntry";

export const ONBOARDING_DRAFT_KEY = "hnbcrm:onboarding-rascunho";
export const ONBOARDING_PATH = "/comecar";
/** `false` até a Onda 3 criar a rota; enquanto isso o destino é o cadastro. */
export const ONBOARDING_ROUTE_READY = false;
export const ONBOARDING_DRAFT_MAX = 2000;

export const ONBOARDING_NICHES = ["clinica", "terapeuta", "corretor", "loja", "eventos", "outro"] as const;
export type OnboardingNiche = (typeof ONBOARDING_NICHES)[number];

export interface OnboardingDraft {
  message: string;
  niche: OnboardingNiche | null;
}

export function parseNiche(raw: unknown): OnboardingNiche | null {
  return typeof raw === "string" && (ONBOARDING_NICHES as readonly string[]).includes(raw) ? (raw as OnboardingNiche) : null;
}

/** Destino atual do hero. */
export function onboardingHref(): string {
  return ONBOARDING_ROUTE_READY ? ONBOARDING_PATH : signUpHref();
}

/** Guarda a mensagem (limitada) e o nicho. Devolve `false` se não há o que guardar ou o navegador não guarda. */
export function saveOnboardingDraft(message: string, niche?: string | null): boolean {
  const draft: OnboardingDraft = {
    message: message.trim().slice(0, ONBOARDING_DRAFT_MAX),
    niche: parseNiche(niche),
  };
  // Nada a guardar: não sobrescreve um rascunho válido anterior.
  if (!draft.message && !draft.niche) return false;
  try {
    sessionStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify(draft));
    return true;
  } catch {
    // Modo privado ou armazenamento bloqueado: a conversa recomeça no destino.
    return false;
  }
}

/** Lê e revalida o rascunho (o valor pode ter sido alterado fora do app). */
export function readOnboardingDraft(): OnboardingDraft | null {
  try {
    const raw = sessionStorage.getItem(ONBOARDING_DRAFT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { message, niche } = parsed as Record<string, unknown>;
    if (typeof message !== "string") return null;
    return { message: message.slice(0, ONBOARDING_DRAFT_MAX), niche: parseNiche(niche) };
  } catch {
    return null;
  }
}

export function clearOnboardingDraft(): void {
  try {
    sessionStorage.removeItem(ONBOARDING_DRAFT_KEY);
  } catch {
    // ver saveOnboardingDraft
  }
}

/**
 * Guarda a mensagem e navega para o onboarding (ou, até a rota existir, para o
 * cadastro). `navigate` vem do roteador; devolve o destino usado.
 */
export function goToOnboarding(message: string, niche: string | null | undefined, navigate: (to: string) => void): string {
  saveOnboardingDraft(message, niche);
  const to = onboardingHref();
  navigate(to);
  return to;
}
