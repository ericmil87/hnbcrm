import { buildBlock } from "../../../../convex/lib/onboardingBlocks";
import { CARD_SECTION, cardSignature, isApproved, type ApprovalSection, type DraftCardKind } from "../../../../convex/lib/onboardingRoadmap";
import type { ApprovalProps } from "./ApprovableCard";
import type { BlockContext, BlockOf } from "./types";

/**
 * O cartão do rascunho remontado do rascunho VIVO (a mesma regra do servidor,
 * `buildBlock`): a mensagem pode ser antiga, o cartão mostra o que está gravado
 * agora. Sem fatos vivos (ou sem rascunho) fica o snapshot da mensagem.
 */
export function liveDraftBlock<K extends DraftCardKind>(block: BlockOf<K>, ctx: Pick<BlockContext, "facts">): BlockOf<K> {
  const f = ctx.facts;
  if (!f?.draft) return block;
  const { kind, note } = block as { kind: K; note?: string };
  const built = buildBlock(
    { kind, ...(note ? { note } : {}) },
    {
      draft: f.draft,
      draftHash: null,
      draftVersion: 0,
      appliedDraftHash: null,
      emailVerified: f.emailVerified,
      aiActive: f.aiActive,
      approvals: f.approvals,
    }
  );
  return (built as BlockOf<K> | null) ?? block;
}

export interface LiveApproval {
  section: ApprovalSection;
  approved: boolean;
  /** Assinatura do conteúdo que a pessoa está vendo agora (vai no `approve`). */
  sig: string;
}

/** Estado de aprovação AO VIVO de um cartão (null = cartão sem seção aprovável ou sem fatos vivos). */
export function liveApproval(kind: DraftCardKind, ctx: Pick<BlockContext, "facts">): LiveApproval | null {
  const section = CARD_SECTION[kind];
  const f = ctx.facts;
  if (!section || !f?.draft) return null;
  return {
    section,
    approved: isApproved({ draft: f.draft, approvals: f.approvals }, section),
    sig: cardSignature(f.draft, kind),
  };
}

/**
 * Props de aprovação do cartão a partir dos fatos vivos. O botão envia o
 * `approve` (com a assinatura do que a pessoa vê); na prévia compacta do
 * painel só o selo.
 */
export function approvalFor(kind: DraftCardKind, ctx: Pick<BlockContext, "facts" | "compact" | "busy" | "sendEvent">): ApprovalProps | undefined {
  const a = liveApproval(kind, ctx);
  if (!a) return undefined;
  return {
    approved: a.approved,
    sig: a.sig,
    busy: ctx.busy,
    ...(ctx.compact
      ? {}
      : { onApprove: (sig?: string) => ctx.sendEvent({ kind: "approve", section: a.section, ...(sig ? { sig } : {}) }) }),
  };
}
