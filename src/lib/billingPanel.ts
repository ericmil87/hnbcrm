/**
 * Regras puras do painel "Uso e fatura" (settings/billing). Sem React, sem
 * relógio: o `now` entra por argumento. Dinheiro e números são formatados na
 * UI por `lib/format.ts`; aqui só se decide o quê mostrar.
 */
import { formatMoney, parseDecimal } from "./format";
import { meterState, monthKeyUtc, projectUsage, usagePercent, type MeterState } from "./usageProjection";

export type BillingMode = "legacy" | "trial" | "active" | "past_due" | "read_only" | "canceled";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Teto aceito pelo servidor (`isValidOverageCap`): inteiro de R$ 1 a R$ 100.000. */
export const OVERAGE_CAP_MIN = 1;
export const OVERAGE_CAP_MAX = 100_000;

/** Arredonda o relógio a 15 min: o `now` vai nos args da query sem reinscrever a cada render. */
export function roundNow(now: number): number {
  const step = 15 * 60 * 1000;
  return Math.floor(now / step) * step;
}

export { monthKeyUtc };

/**
 * Conta em modo leitura? Vale o que o servidor já marcou (`readOnly`) e também o teste
 * vencido que o cron diário ainda não virou (o corte não espera o cron).
 */
export function isEffectivelyReadOnly(
  ent: { readOnly: boolean; mode: BillingMode; trialEndsAt?: number } | null | undefined,
  now: number,
): boolean {
  if (!ent) return false;
  if (ent.readOnly) return true;
  return ent.mode === "trial" && ent.trialEndsAt != null && ent.trialEndsAt <= now;
}

/** O painel só existe para org com plano gravado (modo diferente de `legacy`). */
export function isBillingPanelVisible(mode: BillingMode | null | undefined): boolean {
  return mode !== undefined && mode !== null && mode !== "legacy";
}

// ── Status ──────────────────────────────────────────────────────────────────

export type StatusTone = "success" | "info" | "warning" | "error" | "default";

export interface StatusInfo {
  label: string;
  tone: StatusTone;
  /** Aviso de destaque no topo do painel (pagamento pendente, só leitura). */
  notice: string | null;
}

export function statusInfo(mode: BillingMode): StatusInfo {
  switch (mode) {
    case "trial":
      return { label: "Teste grátis", tone: "info", notice: null };
    case "active":
      return { label: "Ativo", tone: "success", notice: null };
    case "past_due":
      return {
        label: "Pagamento pendente",
        tone: "warning",
        notice: "Há um pagamento pendente. Fale com a gente para regularizar antes que a conta passe para só leitura.",
      };
    case "read_only":
      return {
        label: "Somente leitura",
        tone: "error",
        notice: "A conta está em só leitura: a equipe vê tudo, mas não envia nem cria nada. A exportação dos dados continua liberada.",
      };
    case "canceled":
      return {
        label: "Cancelado",
        tone: "error",
        notice: "A assinatura foi cancelada. Os dados continuam disponíveis para exportação.",
      };
    default:
      return { label: "Sem plano", tone: "default", notice: null };
  }
}

/** Dias que faltam do teste (arredonda para cima; 0 quando venceu). */
export function trialDaysLeft(trialEndsAt: number | undefined, now: number): number | null {
  if (trialEndsAt === undefined) return null;
  return Math.max(0, Math.ceil((trialEndsAt - now) / DAY_MS));
}

export function trialText(daysLeft: number | null): string | null {
  if (daysLeft === null) return null;
  if (daysLeft === 0) return "O teste termina hoje.";
  return daysLeft === 1 ? "Falta 1 dia do teste grátis." : `Faltam ${daysLeft} dias do teste grátis.`;
}

export interface PriceLockInput {
  kind: "founder" | "frozen";
  monthlyBrl?: number;
  discountPct?: number;
  until?: number;
}

/** Texto do preço combinado (fundador/congelado) ou `null` quando não há ou já venceu. */
export function priceLockText(lock: PriceLockInput | null | undefined, now: number): string | null {
  if (!lock) return null;
  if (lock.until !== undefined && lock.until <= now) return null;
  const parts: string[] = [];
  if (lock.monthlyBrl !== undefined) parts.push(`${formatMoney(lock.monthlyBrl)} por mês`);
  if (lock.discountPct !== undefined && lock.discountPct > 0) parts.push(`${lock.discountPct}% de desconto`);
  if (parts.length === 0) return null;
  return `${lock.kind === "founder" ? "Preço de fundador" : "Preço travado"}: ${parts.join(", ")}`;
}

// ── Medidores ───────────────────────────────────────────────────────────────

export interface MeterView {
  id: "attendances" | "campaignSends" | "channels" | "aiGroups";
  label: string;
  used: number;
  /** `null` = sem limite no plano. */
  limit: number | null;
  percent: number | null;
  state: MeterState;
}

export interface UsageSummaryLike {
  month: string;
  attendances: {
    total: number;
    included: number;
    credit: number;
    overage: number;
    suggestOnly: number;
    overageBrlCents: number;
    limit: number | null;
  };
  campaignSends: { used: number; limit: number | null };
}

export interface ChannelUsageLike {
  channels: { active: number; limit: number | null; truncated: boolean };
  aiGroups: { used: number; limit: number | null; truncated: boolean };
}

function meter(id: MeterView["id"], label: string, used: number, limit: number | null): MeterView {
  return { id, label, used, limit, percent: usagePercent(used, limit), state: meterState(used, limit) };
}

export function buildMeters(summary: UsageSummaryLike, usage: ChannelUsageLike | undefined): MeterView[] {
  const list: MeterView[] = [
    meter("attendances", "Atendimentos IA", summary.attendances.total, summary.attendances.limit),
    meter("campaignSends", "Envios de campanha", summary.campaignSends.used, summary.campaignSends.limit),
  ];
  if (usage) {
    list.push(meter("channels", "Canais", usage.channels.active, usage.channels.limit));
    list.push(meter("aiGroups", "Grupos com IA", usage.aiGroups.used, usage.aiGroups.limit));
  }
  return list;
}

/** Texto do estado do medidor para quem não vê a cor. */
export function meterStateText(state: MeterState): string {
  if (state === "limit100") return "Limite atingido";
  if (state === "warn80") return "Perto do limite";
  return "Dentro do limite";
}

export interface AttendanceProjection {
  projected: number;
  /** Passa do limite até o fim do mês neste ritmo. */
  exceeds: boolean;
}

/** Estimativa de fechamento do mês (só com limite e algum uso). */
export function attendanceProjection(
  used: number,
  limit: number | null,
  monthKey: string,
  now: number,
): AttendanceProjection | null {
  if (limit === null || used <= 0) return null;
  const projected = projectUsage(used, monthKey, now);
  return { projected, exceeds: projected > limit };
}

// ── Excedente ───────────────────────────────────────────────────────────────

export interface OverageEligibility {
  canEnable: boolean;
  /** Por que não pode ligar (mostrado ao usuário). */
  reason: string | null;
}

export function overageEligibility(mode: BillingMode): OverageEligibility {
  if (mode === "active" || mode === "past_due") return { canEnable: true, reason: null };
  if (mode === "trial") {
    return {
      canEnable: false,
      reason: "O excedente fica disponível depois que você contrata um plano. No teste grátis a IA para de responder sozinha quando a franquia acaba.",
    };
  }
  return {
    canEnable: false,
    reason: "O excedente só está disponível em planos contratados e ativos. Fale com a gente para ativar o seu plano.",
  };
}

export type CapParse = { ok: true; capBrl: number } | { ok: false; error: string };

/** Teto digitado (R$ inteiro, vírgula ou ponto) -> valor aceito pelo servidor. */
export function parseCapBrl(raw: string): CapParse {
  const n = parseDecimal(raw);
  if (n === null) return { ok: false, error: "Informe o teto em reais, por exemplo 250." };
  if (!Number.isInteger(n)) return { ok: false, error: "Use um valor inteiro em reais, sem centavos." };
  if (n < OVERAGE_CAP_MIN || n > OVERAGE_CAP_MAX) {
    return {
      ok: false,
      error: `O teto deve ficar entre ${formatMoney(OVERAGE_CAP_MIN, "BRL", { fractionDigits: 0 })} e ${formatMoney(OVERAGE_CAP_MAX, "BRL", { fractionDigits: 0 })}.`,
    };
  }
  return { ok: true, capBrl: n };
}

/** Texto do aceite: cobra R$ X por atendimento além da franquia, até o teto. */
export function overageConfirmText(capBrl: number, unitBrlCents: number | null): string {
  const cap = formatMoney(capBrl, "BRL", { fractionDigits: 0 });
  const unit = unitBrlCents === null ? "o valor do seu plano" : formatMoney(unitBrlCents / 100);
  return `Você será cobrado ${unit} por atendimento IA além da franquia do plano, até o teto de ${cap} por mês. Ao chegar no teto, a IA volta a só sugerir respostas. Dá para desligar quando quiser.`;
}

/** Quantos atendimentos a mais o teto cobre (arredonda para baixo). */
export function attendancesCoveredByCap(capBrl: number, unitBrlCents: number | null): number | null {
  if (unitBrlCents === null || unitBrlCents <= 0) return null;
  return Math.floor((capBrl * 100) / unitBrlCents);
}

// ── Estimativa da fatura ────────────────────────────────────────────────────

export interface InvoiceEstimateLike {
  planBrl: number;
  extraChannelsBrl: number;
  groupsAddonBrl: number;
  listBrl: number;
  recurringBrl: number;
  overageBrl: number;
  totalBrl: number;
}

export interface InvoiceLine {
  id: "plan" | "extraChannels" | "groupsAddon" | "priceLock" | "overage";
  label: string;
  amountBrl: number;
}

export function invoiceLines(estimate: InvoiceEstimateLike, planLabel: string | null): InvoiceLine[] {
  const lines: InvoiceLine[] = [{ id: "plan", label: planLabel ? `Plano ${planLabel}` : "Plano", amountBrl: estimate.planBrl }];
  if (estimate.extraChannelsBrl > 0) lines.push({ id: "extraChannels", label: "Canais extra", amountBrl: estimate.extraChannelsBrl });
  if (estimate.groupsAddonBrl > 0) lines.push({ id: "groupsAddon", label: "Add-on Grupos", amountBrl: estimate.groupsAddonBrl });
  const lockDelta = Math.round((estimate.recurringBrl - estimate.listBrl) * 100) / 100;
  if (lockDelta !== 0) lines.push({ id: "priceLock", label: "Preço combinado", amountBrl: lockDelta });
  if (estimate.overageBrl > 0) lines.push({ id: "overage", label: "Excedente do mês", amountBrl: estimate.overageBrl });
  return lines;
}

// ── Créditos ────────────────────────────────────────────────────────────────

export function creditSourceLabel(source: "pack" | "courtesy" | "migration"): string {
  if (source === "pack") return "Pacote de atendimentos";
  if (source === "courtesy") return "Cortesia";
  return "Migração";
}

/** Crédito vence em até 30 dias. */
export function creditExpiresSoon(expiresAt: number, now: number): boolean {
  return expiresAt - now <= 30 * DAY_MS;
}

// ── Extrato ─────────────────────────────────────────────────────────────────

export type AttendanceBilling = "included" | "credit" | "overage" | "suggest_only" | "legacy";

export function attendanceBillingLabel(b: AttendanceBilling): string {
  switch (b) {
    case "included":
      return "Na franquia";
    case "credit":
      return "Crédito";
    case "overage":
      return "Excedente";
    case "suggest_only":
      return "Só sugestão";
    default:
      return "Antes do medidor";
  }
}

// ── Contato ─────────────────────────────────────────────────────────────────

/** Contato comercial para trocar de plano (confirmar o endereço antes de publicar). */
export const BILLING_CONTACT_EMAIL = "contato@hnbcrm.com";

export function changePlanMailto(orgName: string | null, planLabel: string | null): string {
  const subject = `Quero mudar de plano${orgName ? ` (${orgName})` : ""}`;
  const body = `Olá! Quero conversar sobre a troca de plano. Plano atual: ${planLabel ?? "sem plano"}.`;
  return `mailto:${BILLING_CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
