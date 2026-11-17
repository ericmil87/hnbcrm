/** Regras puras do aceite dos Termos (a versão vigente vem de `convex/lib/terms.ts`). */
export interface TermsStatusLike {
  /** Versão que precisa ser aceita para o banner sumir (igual ao aceite de quem já cumpre o mínimo). */
  currentVersion: string;
  acceptedVersion: string | null;
  /** Versão do texto vigente (a que o aceite grava). Ausente em backend antigo. */
  textVersion?: string;
}

/** Versão a enviar em `acceptTerms`: a do texto, não a de comparação. */
export function versionToAccept(status: TermsStatusLike): string {
  return status.textVersion ?? status.currentVersion;
}

/** Pede aceite só com sessão (status não nulo) e sem aceite da versão vigente. */
export function needsTermsAcceptance(status: TermsStatusLike | null | undefined): boolean {
  if (!status) return false;
  return status.acceptedVersion !== status.currentVersion;
}

/** Criar organização exige nome e a caixa de aceite marcada. */
export function canSubmitOrganization(args: { name: string; accepted: boolean }): boolean {
  return args.name.trim() !== "" && args.accepted;
}
