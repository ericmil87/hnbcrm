import type { OnboardingBlock, OnboardingBlockKind } from "../../../../convex/lib/onboardingBlocks";
import type { OnboardingDraft } from "../../../../convex/lib/onboardingDraft";
import type { ApprovalSection } from "../../../../convex/lib/onboardingRoadmap";
import type { OnboardingEvent } from "@/lib/onboardingStream";

export type { OnboardingBlock, OnboardingBlockKind };

/** Bloco de um tipo específico do union `OnboardingBlock` (`convex/lib/onboardingBlocks.ts`). */
export type BlockOf<K extends OnboardingBlockKind> = Extract<OnboardingBlock, { kind: K }>;

/**
 * Fatos VIVOS da sessão (do servidor, reativos): os cartões calculam o que
 * mostram (aprovado, ativo, testado...) a partir deles, nunca do snapshot da
 * mensagem em que nasceram.
 */
export interface LiveFacts {
  /** Rascunho gravado agora. */
  draft: OnboardingDraft | null;
  /** Assinatura aprovada por seção (`isApproved` compara com o rascunho vivo). */
  approvals: Partial<Record<ApprovalSection, string>>;
  aiActive: boolean;
  /** Existe operação montada. */
  applied: boolean;
  tested: boolean;
  connected: boolean;
  emailVerified: boolean;
  maskedEmail?: string | null;
  pendingMaterials?: number;
}

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
  /**
   * Avisa o servidor que uma ação de cartão terminou (aprovar, e-mail confirmado,
   * ativada, testada, conectada, pedir o próximo passo). Sem LLM; o Copiloto
   * responde com a fala e o cartão do próximo passo.
   */
  sendEvent: (event: OnboardingEvent) => void;
  /** Fatos vivos da sessão (ausentes na prévia sem sessão). */
  facts?: LiveFacts;
  /** O bloco é da última resposta do Copiloto (ações de convite só valem nela). */
  isLatest: boolean;
  /** Prévia do desktop (`DraftPreviewPanel`): os mesmos cartões, mais enxutos. */
  compact?: boolean;
}

export interface BlockProps<K extends OnboardingBlockKind> {
  block: BlockOf<K>;
  ctx: BlockContext;
}
