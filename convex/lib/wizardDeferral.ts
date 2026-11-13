/**
 * Adiamento do assistente de configuração (formulário em tela cheia).
 *
 * Uma porta só para "não abrir o assistente sozinho": o botão "Continuar
 * depois" (`onboarding.deferWizard`) e a aplicação do rascunho da conversa de
 * configuração (`lib/onboardingApply.ts`) gravam `onboardingMeta.wizardDeferredAt`
 * pelo mesmo patch. A rota `/app/configuracao-inicial` continua abrindo o
 * assistente para quem quiser; só a abertura automática some.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type OnboardingMeta = NonNullable<Doc<"organizations">["onboardingMeta"]>;

/** Meta com o adiamento gravado (mantém um adiamento anterior). */
export function withWizardDeferred(meta: OnboardingMeta | undefined, now: number): OnboardingMeta {
  return { ...(meta ?? {}), wizardDeferredAt: meta?.wizardDeferredAt ?? now };
}

/**
 * Adia o assistente da org (idempotente). Org que já concluiu o assistente
 * (`wizardCompletedAt`) ou já adiou não é tocada.
 */
export async function deferWizardCore(
  ctx: MutationCtx,
  org: Doc<"organizations">,
  now: number,
): Promise<boolean> {
  const meta = org.onboardingMeta;
  if (meta?.wizardCompletedAt !== undefined || meta?.wizardDeferredAt !== undefined) return false;
  await ctx.db.patch(org._id, { onboardingMeta: withWizardDeferred(meta, now), updatedAt: now });
  return true;
}

/**
 * Sessões lidas por org: a conversa cria poucas (uma + recomeços). A leitura só
 * acontece para admin de org que ainda mostraria o assistente (não concluiu nem
 * adiou), então não pesa no `getOnboardingProgress` assinado pelo `AuthLayout`.
 */
const SESSION_SCAN = 10;

/**
 * A org já montou a operação pela conversa de configuração (alguma sessão,
 * arquivada ou não, aplicada; ou recomeçada depois de aplicada). Serve para
 * as orgs que aplicaram ANTES de a aplicação gravar o adiamento: derivado na
 * leitura, sem migração.
 */
export async function hasAppliedOnboardingConversation(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
): Promise<boolean> {
  const sessions = await ctx.db
    .query("onboardingSessions")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .order("desc")
    .take(SESSION_SCAN);
  return sessions.some((s) => s.appliedAt !== undefined || s.priorAppliedAt !== undefined);
}
