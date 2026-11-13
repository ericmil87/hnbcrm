/**
 * "Recomeçar a conversa" do `/comecar` e o resumo de entrada de quem já tem
 * empresa. Módulo puro (sem `ctx`): `onboardingSessions.ts` lê os dados e
 * chama estas regras.
 *
 * Semântica do recomeço: a sessão atual é ARQUIVADA e nasce outra. A nova
 * herda SÓ o que não pode zerar:
 *   - `spentUsdMicros` (orçamento da sessão; senão recomeçar viraria drible do
 *     teto) e `lastEstimateUsdMicros`;
 *   - a ciência do aviso de materiais e o envio automático do código de e-mail
 *     (recomeçar não pede de novo nem manda outro e-mail);
 *   - `priorAppliedAt`: a operação já foi montada antes (o CRM continua igual).
 * Não herda: rascunho, aprovações, cartões mostrados, etapa alcançada, teste,
 * canal, links pendentes, resumo, contagem e `attendantId` (o atendente que a
 * conversa antiga criou passa a ser "atendente que já existe": protegido, só
 * sobrescrito por clique explícito).
 * Contadores que moram fora da sessão não são tocados: `onboardingRateLimits`
 * (usuário/org/IP), `aiUsageMonthly` (orçamento de teste da org e teto de
 * gastos), `onboardingSpendDaily` (corte global).
 */
import type { Doc } from "../_generated/dataModel";

/** Recomeços por organização: no máximo 3 por hora e 10 por dia. */
export const RESTART_LIMITS = { perHour: 3, perDay: 10 } as const;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const RESTART_RATE_LIMIT_MESSAGE =
  "Você recomeçou a conversa várias vezes em pouco tempo. Espere um pouco e tente de novo.";
export const ARCHIVED_SESSION_MESSAGE =
  "Esta conversa foi recomeçada em outra aba. Recarregue a página para continuar.";

export type RestartRateDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * Decide se mais um recomeço cabe. `archivedTimes` = `archivedAt` das sessões
 * arquivadas recentes da org (qualquer ordem). Janela deslizante.
 */
export function evaluateRestartRate(archivedTimes: readonly number[], now: number): RestartRateDecision {
  const inDay = archivedTimes.filter((t) => t > now - DAY_MS && t <= now).sort((a, b) => a - b);
  const inHour = inDay.filter((t) => t > now - HOUR_MS);
  if (inHour.length >= RESTART_LIMITS.perHour) {
    return { allowed: false, retryAfterMs: Math.max(1000, inHour[inHour.length - RESTART_LIMITS.perHour] + HOUR_MS - now) };
  }
  if (inDay.length >= RESTART_LIMITS.perDay) {
    return { allowed: false, retryAfterMs: Math.max(1000, inDay[inDay.length - RESTART_LIMITS.perDay] + DAY_MS - now) };
  }
  return { allowed: true };
}

type SessionDoc = Doc<"onboardingSessions">;

/** A sessão tem algo a recomeçar? (vazia = recomeçar não faz nada) */
export function sessionHasProgress(s: Pick<SessionDoc, "messageCount" | "draftVersion" | "pendingMaterials" | "appliedAt">, hasMessages: boolean): boolean {
  return hasMessages || s.messageCount > 0 || s.draftVersion > 0 || (s.pendingMaterials?.length ?? 0) > 0 || s.appliedAt !== undefined;
}

/** Campos que a sessão NOVA herda da arquivada (ver o topo do arquivo). */
export function restartCarryOver(old: SessionDoc) {
  const priorAppliedAt = old.appliedAt ?? old.priorAppliedAt;
  return {
    spentUsdMicros: old.spentUsdMicros,
    ...(old.lastEstimateUsdMicros !== undefined ? { lastEstimateUsdMicros: old.lastEstimateUsdMicros } : {}),
    ...(old.materialsNoticeAckAt !== undefined ? { materialsNoticeAckAt: old.materialsNoticeAckAt } : {}),
    ...(old.materialsNoticeAckBy !== undefined ? { materialsNoticeAckBy: old.materialsNoticeAckBy } : {}),
    ...(old.emailCodeAutoSentAt !== undefined ? { emailCodeAutoSentAt: old.emailCodeAutoSentAt } : {}),
    ...(priorAppliedAt !== undefined ? { priorAppliedAt } : {}),
    restartedFrom: old._id,
  };
}

// ── Resumo de entrada (`getEntryOverview`) ──────────────────────────────────

export type EntryConversationState = "none" | "in_progress" | "applied";

/** Estado da conversa da org a partir da sessão mais recente. */
export function entryConversationState(
  s: Pick<SessionDoc, "messageCount" | "draftVersion" | "appliedAt" | "priorAppliedAt" | "pendingMaterials"> | null,
): EntryConversationState {
  if (!s) return "none";
  if (s.appliedAt !== undefined) return "applied";
  if (s.messageCount > 0 || s.draftVersion > 0 || (s.pendingMaterials?.length ?? 0) > 0) return "in_progress";
  // Recomeçada e ainda vazia, depois de uma operação montada: conta como aplicada.
  if (s.priorAppliedAt !== undefined) return "applied";
  return "none";
}

/**
 * A org já tem uma operação de verdade (algo que a conversa poderia mexer)?
 * Qualquer sinal basta: conversa aplicada, assistente concluído, atendente IA,
 * WhatsApp conectado ou leads no CRM.
 */
export function entryOrgConfigured(input: {
  conversation: EntryConversationState;
  wizardCompleted: boolean;
  hasAttendant: boolean;
  whatsappConnected: boolean;
  hasLeads: boolean;
}): boolean {
  return (
    input.conversation === "applied" || input.wizardCompleted || input.hasAttendant || input.whatsappConnected || input.hasLeads
  );
}

export type NewOrgTrial = "none" | "fresh" | "shared_active" | "shared_expired";

/**
 * O que acontece com o teste grátis se a pessoa criar OUTRA empresa (espelha
 * `organizations.createOrganization`: 1 teste por usuário, a 2ª org herda o
 * `endsAt` do 1º grant). `trialOnSignup` = env `BILLING_TRIAL_ON_SIGNUP`.
 */
export function newOrgTrialFor(trialOnSignup: boolean, firstGrantEndsAt: number | null, now: number): NewOrgTrial {
  if (!trialOnSignup) return "none";
  if (firstGrantEndsAt === null) return "fresh";
  return firstGrantEndsAt > now ? "shared_active" : "shared_expired";
}
