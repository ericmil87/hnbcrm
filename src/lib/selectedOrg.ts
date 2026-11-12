/**
 * Org escolhida neste navegador (`localStorage`), compartilhada entre o
 * `AuthLayout` (/app) e a conversa pública de `/comecar`, que roda fora dele.
 * É só preferência: quem lê sempre revalida contra a lista de orgs do usuário.
 */
export const SELECTED_ORG_KEY = "hnbcrm.selectedOrgId";

export function readSelectedOrgId(): string | null {
  try {
    return localStorage.getItem(SELECTED_ORG_KEY);
  } catch {
    return null;
  }
}

export function writeSelectedOrgId(orgId: string): void {
  try {
    localStorage.setItem(SELECTED_ORG_KEY, orgId);
  } catch {
    // localStorage indisponível (modo privado): segue só em memória
  }
}

/** Org para a conversa: a salva, se o usuário ainda é membro; senão a primeira da lista. */
export function pickOnboardingOrg<T extends { _id: string }>(orgs: readonly T[], storedId: string | null): T | null {
  if (orgs.length === 0) return null;
  return orgs.find((o) => o._id === storedId) ?? orgs[0];
}
