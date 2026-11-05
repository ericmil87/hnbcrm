/**
 * Allowlist da guarda de vocabulário (`vocabGuard.test.ts`).
 * Não adicione entradas sem motivo: cada exceção pontual exige `reason` e o teto é 30.
 */

/** Caminhos (prefixo com `/**` ou arquivo exato) onde termos técnicos são permitidos. */
export const ALLOWED_PATHS: readonly string[] = [
  "src/pages/DevelopersPage.tsx",
  "src/pages/PlaygroundPage.tsx",
  "src/components/developers/**",
  "src/lib/apiRegistry.ts",
  "src/pages/TermsPage.tsx",
  "src/pages/PrivacyPage.tsx",
  "src/components/settings/advanced/**",
  "src/embed/**",
  "src/components/landing/**",
  "src/pages/LandingPage.tsx",
  "src/components/LandingPage.tsx",
];

export interface AllowedTerm {
  /** Trecho exato encontrado (comparado sem diferenciar maiúsculas). */
  term: string;
  file: string;
  reason: string;
}

export const MAX_ALLOWED_TERMS = 30;

/** Exceções pontuais. */
export const ALLOWED_TERMS: readonly AllowedTerm[] = [];

/**
 * Arquivos fora do escopo do PR fv2-07 que ainda têm termos antigos.
 * TODO(fv2-29): zerar esta lista (cada PR de tela remove seus arquivos).
 */
export const PENDING_SCOPE: readonly string[] = [
  // Nomes padrão de funil gravados na organização (dado persistido): decidir se muda no fv2-29.
  "src/lib/onboardingTemplates.ts",
];

/** Pastas/arquivos cobertos pelo teste de sentence case (cresce por PR). */
export const SENTENCE_CASE_SCOPE: readonly string[] = [
  "src/components/ui/",
  "src/components/layout/",
  "src/components/settings/",
  "src/components/Inbox.tsx",
  "src/components/inbox/",
  "src/components/HandoffQueue.tsx",
  "src/components/KanbanBoard.tsx",
];

export function matchesPath(file: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) return file.startsWith(pattern.slice(0, -2));
  return file === pattern;
}
