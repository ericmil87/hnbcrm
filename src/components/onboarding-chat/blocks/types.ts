import type { OnboardingBlock, OnboardingBlockKind } from "../../../../convex/lib/onboardingBlocks";

export type { OnboardingBlock, OnboardingBlockKind };

/** Bloco de um tipo específico do union `OnboardingBlock` (`convex/lib/onboardingBlocks.ts`). */
export type BlockOf<K extends OnboardingBlockKind> = Extract<OnboardingBlock, { kind: K }>;

/**
 * Contexto que TODO bloco recebe (igual para todos). Os blocos são de
 * apresentação + no máximo uma chamada ao Convex disparada por clique da
 * pessoa (P3.2/P3.3); nenhum executa ação sozinho ao montar.
 */
export interface BlockContext {
  /** Org da conversa (null antes do login / sem org: blocos de ação ficam desabilitados). */
  organizationId: string | null;
  /** Sessão do onboarding (null antes de `getOrCreateSession`). */
  sessionId: string | null;
  /** Envia um texto como turno da pessoa (chips, "Ajustar", respostas prontas). */
  sendText: (text: string) => void;
  /** Um turno está em andamento: ações que enviam texto ficam desabilitadas. */
  busy: boolean;
  /** O bloco é da última resposta do Copiloto (ações de convite só valem nela). */
  isLatest: boolean;
}

export interface BlockProps<K extends OnboardingBlockKind> {
  block: BlockOf<K>;
  ctx: BlockContext;
}
