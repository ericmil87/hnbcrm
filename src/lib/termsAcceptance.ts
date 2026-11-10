/** Regras puras do aceite dos Termos (a versão vigente vem de `convex/lib/terms.ts`). */
export interface TermsStatusLike {
  currentVersion: string;
  acceptedVersion: string | null;
}

/** Pede aceite só com sessão (status não nulo) e sem aceite da versão vigente. */
export function needsTermsAcceptance(status: TermsStatusLike | null | undefined): boolean {
  if (!status) return false;
  return status.acceptedVersion !== status.currentVersion;
}

/** Criar organização exige nome, identificador e a caixa de aceite marcada. */
export function canSubmitOrganization(args: { name: string; slug: string; accepted: boolean }): boolean {
  return args.name.trim() !== "" && args.slug.trim() !== "" && args.accepted;
}
