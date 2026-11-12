/**
 * Porta de entrada do onboarding conversacional a partir da landing (hero).
 * Guarda a mensagem do visitante só no navegador (sessionStorage, nunca vai a
 * servidor nenhum antes da conta) e leva para o destino. Quando a rota
 * `/comecar` existe (`ONBOARDING_ROUTE_READY`), `startHref` é a fonte única do
 * destino de todos os CTAs de cadastro da landing e dos preços.
 */
import type { PlanKey } from "../../convex/lib/plans";
import { parsePlanKey, signUpHref } from "./authEntry";

export const ONBOARDING_DRAFT_KEY = "hnbcrm:onboarding-rascunho";
export const ONBOARDING_PATH = "/comecar";
/** A rota `/comecar` existe. `false` = rollback: todos os CTAs voltam ao cadastro antigo (`/entrar?modo=cadastro`). */
export const ONBOARDING_ROUTE_READY = true;
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

/**
 * Destino de todo CTA de cadastro ("Testar grátis", "Começar grátis", "Testar 30
 * dias grátis", hero, CTA final, preços). Mantém `?plano=` quando houver.
 */
export function startHref(plan?: PlanKey | string | null): string {
  // Plano inválido (valor vindo de fora do tipo) = sem query.
  const valid = parsePlanKey(plan);
  if (!ONBOARDING_ROUTE_READY) return valid ? signUpHref(valid) : signUpHref();
  return valid ? `${ONBOARDING_PATH}?plano=${valid}` : ONBOARDING_PATH;
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
 * Guarda a mensagem e navega para o onboarding. `navigate` vem do roteador;
 * devolve o destino usado.
 */
export function goToOnboarding(
  message: string,
  niche: string | null | undefined,
  navigate: (to: string) => void,
  plan?: PlanKey | null
): string {
  saveOnboardingDraft(message, niche);
  const to = startHref(plan);
  navigate(to);
  return to;
}
