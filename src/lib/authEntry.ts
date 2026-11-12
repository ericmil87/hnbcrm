/**
 * Parâmetros de entrada em /entrar: `?modo=cadastro` (só muda o título do primeiro
 * passo da entrada unificada, `components/auth/EmailEntryCard.tsx`; o caminho é decidido
 * pela checagem do e-mail) e `?plano=<id>` (plano de interesse vindo dos botões de preço).
 * O plano é validado contra os ids reais de `convex/lib/plans.ts` e guardado em
 * sessionStorage até a criação da organização (hoje `createOrganization` ainda
 * não recebe plano; o encaixe é `src/components/org/OrgSwitcher.tsx`, após criar a org).
 */
import { PLAN_KEYS, type PlanKey } from "../../convex/lib/plans";

export type AuthFlow = "signIn" | "signUp";

export const PLAN_INTENT_STORAGE_KEY = "hnbcrm:plano-de-interesse";

export function parseAuthFlow(raw: string | null | undefined): AuthFlow {
  return raw === "cadastro" ? "signUp" : "signIn";
}

export function parsePlanKey(raw: string | null | undefined): PlanKey | null {
  if (!raw) return null;
  return (PLAN_KEYS as readonly string[]).includes(raw) ? (raw as PlanKey) : null;
}

export function storePlanIntent(plan: PlanKey | null): void {
  if (!plan) return;
  try {
    sessionStorage.setItem(PLAN_INTENT_STORAGE_KEY, plan);
  } catch {
    // Armazenamento indisponível (modo privado, bloqueado): o plano é só dica.
  }
}

/** Lê o plano guardado, revalidando (o valor pode ter sido alterado fora do app). */
export function readPlanIntent(): PlanKey | null {
  try {
    return parsePlanKey(sessionStorage.getItem(PLAN_INTENT_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function clearPlanIntent(): void {
  try {
    sessionStorage.removeItem(PLAN_INTENT_STORAGE_KEY);
  } catch {
    // ver storePlanIntent
  }
}

/** Link de cadastro dos botões "Começar grátis"; mantém `?plano=` quando houver. */
export function signUpHref(plan?: PlanKey): string {
  return plan ? `/entrar?modo=cadastro&plano=${plan}` : "/entrar?modo=cadastro";
}
