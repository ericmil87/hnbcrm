/**
 * Banner global de plano e uso (AppShell). Puro: o relógio e as dispensas entram
 * por argumento. Um banner por vez; prioridade: só leitura > atraso > teste
 * (até 7 dias) > 100% > 80% > teste em andamento. Nunca em org legada.
 */
import { formatMoney } from "./format";
import { isEffectivelyReadOnly, monthKeyUtc, trialDaysLeft, type BillingMode } from "./billingPanel";

export type BannerKind = "read_only" | "past_due" | "trial_ending" | "limit100" | "warn80" | "trial";
export type BannerTone = "error" | "warning" | "info";

export interface BannerEntitlements {
  mode: BillingMode;
  readOnly: boolean;
  trialEndsAt?: number;
  /** Pior medidor do mês; ausente = "ok" (backend ainda não manda). */
  usageLevel?: "ok" | "warn80" | "limit100";
  /** Mês ("AAAA-MM") do alerta de uso, para a dispensa valer até o fim dele. */
  usageAlertMonth?: string;
  overage?: { enabled: boolean; capBrl: number | null };
}

export interface BillingBanner {
  kind: BannerKind;
  tone: BannerTone;
  title: string;
  body: string;
  /** Sem CTA para quem não administra. */
  cta: { label: string; to: string } | null;
  dismissible: boolean;
  /** Chave da dispensa (muda com o período, então a dispensa expira sozinha). */
  dismissKey: string | null;
}

export const BILLING_PANEL_PATH = "/app/configuracoes?secao=billing";
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

function monthOf(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function resolveBillingBanner(args: {
  ent: BannerEntitlements | null | undefined;
  now: number;
  /** Quem vê o painel "Uso e fatura" (settings:view). */
  canViewBilling: boolean;
  dismissed: ReadonlySet<string>;
}): BillingBanner | null {
  const { ent, now, canViewBilling, dismissed } = args;
  if (!ent || ent.mode === "legacy") return null;
  const to = BILLING_PANEL_PATH;
  const cta = (label: string) => (canViewBilling ? { label, to } : null);
  const adminHint = canViewBilling ? "" : " Peça a um administrador.";

  const pick = (b: BillingBanner): BillingBanner | null =>
    b.dismissible && b.dismissKey !== null && dismissed.has(b.dismissKey) ? null : b;

  // Alerta de uso de outro mês não vale (100% de novembro não aparece em dezembro).
  const usageLevel = ent.usageAlertMonth === monthKeyUtc(now) ? ent.usageLevel : undefined;

  if (isEffectivelyReadOnly(ent, now) || ent.mode === "read_only" || ent.mode === "canceled") {
    return {
      kind: "read_only",
      tone: "error",
      title: "Sua conta está em modo leitura",
      body: `Seus dados estão guardados e a exportação continua liberada.${adminHint}`,
      cta: cta("Ver plano"),
      dismissible: false,
      dismissKey: null,
    };
  }

  if (ent.mode === "past_due") {
    return {
      kind: "past_due",
      tone: "warning",
      title: "Pagamento pendente",
      body: `Regularize o pagamento para a conta não passar para modo leitura.${adminHint}`,
      cta: cta("Ver fatura"),
      dismissible: false,
      dismissKey: null,
    };
  }

  const days = ent.mode === "trial" ? trialDaysLeft(ent.trialEndsAt, now) : null;
  const dayText = (d: number) => (d === 0 ? "O teste grátis termina hoje" : d === 1 ? "Falta 1 dia do teste grátis" : `Faltam ${d} dias do teste grátis`);

  if (days !== null && days <= 7) {
    return pick({
      kind: "trial_ending",
      tone: "warning",
      title: dayText(days),
      body: `Depois disso a conta passa para modo leitura, com exportação liberada.${adminHint}`,
      cta: cta("Escolher plano"),
      dismissible: true,
      dismissKey: `trial_ending:${Math.floor(now / DAY)}`,
    });
  }

  if (usageLevel === "limit100") {
    const overage = ent.overage;
    const second = overage?.enabled
      ? `Se for a de atendimentos, o excedente está ligado${overage.capBrl !== null ? `, com teto de ${formatMoney(overage.capBrl, "BRL", { fractionDigits: 0 })}` : ""}.`
      : "Se for a de atendimentos, a IA passa a só sugerir respostas e a equipe envia.";
    return {
      kind: "limit100",
      tone: "warning",
      title: "Você chegou a 100% da franquia do mês",
      body: `Atendimentos da IA ou envios de campanha: veja o detalhe em Uso e fatura. ${second}${adminHint}`,
      cta: cta("Ver uso"),
      dismissible: false,
      dismissKey: null,
    };
  }

  if (usageLevel === "warn80") {
    return pick({
      kind: "warn80",
      tone: "warning",
      title: "Você usou 80% da franquia do mês",
      body: `Atendimentos da IA ou envios de campanha: veja o detalhe em Uso e fatura.${adminHint}`,
      cta: cta("Ver uso"),
      dismissible: true,
      dismissKey: `warn80:${ent.usageAlertMonth ?? monthOf(now)}`,
    });
  }

  if (days !== null) {
    return pick({
      kind: "trial",
      tone: "info",
      title: dayText(days),
      body: "Você está testando o plano Profissional.",
      cta: cta("Ver planos"),
      dismissible: true,
      dismissKey: `trial:${Math.floor(now / WEEK)}`,
    });
  }

  return null;
}

// ── Dispensa (localStorage, sempre em try/catch) ────────────────────────────

const storageKey = (organizationId: string) => `hnbcrm.billingBanner.${organizationId}`;

export function readDismissed(organizationId: string, storage: Pick<Storage, "getItem"> | null): Set<string> {
  try {
    const raw = storage?.getItem(storageKey(organizationId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

export function writeDismissed(
  organizationId: string,
  keys: ReadonlySet<string>,
  storage: Pick<Storage, "setItem"> | null,
): void {
  try {
    // Guarda só as 20 mais recentes: as chaves expiram sozinhas com o período.
    storage?.setItem(storageKey(organizationId), JSON.stringify([...keys].slice(-20)));
  } catch {
    // Sem armazenamento (modo privado): a dispensa vale só nesta sessão.
  }
}
