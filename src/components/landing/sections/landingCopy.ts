/**
 * Contrato comum das seções da landing: âncoras (usadas pela navegação, pelo
 * rodapé e pelos links "Ver como funciona") e textos repetidos entre seções.
 * Copy aprovada em `temp/landing-onboarding-v2/copy/landing.md` (11/11/2026).
 * Números vêm do catálogo, nunca digitados.
 */
import { TRIAL } from "../../../../convex/lib/plans";
import { REFUND_DAYS } from "../pricing/pricingCopy";

export const LANDING_ANCHORS = {
  hero: "inicio",
  machine: "como-funciona",
  team: "time",
  profiles: "perfis",
  howItStarts: "como-comeca",
  price: "precos",
  services: "feito-com-voce",
  socialProof: "quem-usa",
  community: "comunidade",
  faq: "perguntas",
  finalCta: "comecar",
} as const;

export type LandingAnchor = (typeof LANDING_ANCHORS)[keyof typeof LANDING_ANCHORS];

/** "30 dias grátis · sem cartão · reembolso em 7 dias" (hero e CTA final). */
export function trustLine(): string {
  return `${TRIAL.days} dias grátis · sem cartão · reembolso em ${REFUND_DAYS} dias`;
}

/** Rótulo do botão principal do cabeçalho. */
export const PRIMARY_CTA_LABEL = "Testar grátis";
