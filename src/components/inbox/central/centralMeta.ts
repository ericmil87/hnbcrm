/**
 * Rótulos, ícones e formatações do MVP "Central" no inbox (setores, unidades,
 * tipo de contato, desfecho e origem do anúncio). Puro — testado em
 * `centralMeta.test.ts`.
 */
import {
  BedDouble,
  Briefcase,
  Building2,
  Facebook,
  Globe,
  Instagram,
  Megaphone,
  Repeat,
  Search,
  Sprout,
  Truck,
  UserPlus,
  UserRound,
  type LucideIcon,
} from "lucide-react";

export type ContactKind = "lead" | "guest" | "supplier" | "agency" | "other";

export const CONTACT_KINDS: { id: ContactKind; label: string; icon: LucideIcon }[] = [
  { id: "lead", label: "Lead de reserva", icon: BedDouble },
  { id: "guest", label: "Hóspede", icon: UserRound },
  { id: "supplier", label: "Fornecedor", icon: Truck },
  { id: "agency", label: "Agência", icon: Briefcase },
  { id: "other", label: "Outro", icon: Building2 },
];

export function contactKindLabel(kind: string | null | undefined): string {
  return CONTACT_KINDS.find((k) => k.id === kind)?.label ?? "Lead de reserva";
}

/** Motivos de "Não convertido" — o último ("Outro") abre o campo livre. */
export const LOST_REASONS = [
  "Preço acima do esperado",
  "Sem disponibilidade nas datas",
  "Escolheu outro hotel",
  "Política de pet",
  "Política de cancelamento / não reembolsável",
  "Desistiu da viagem / mudou as datas",
  "Parou de responder",
  "Outro",
] as const;

export interface LeadAttribution {
  source: string;
  campaignName?: string;
  campaignKey?: string;
  adId?: string;
  adHeadline?: string;
  adSourceUrl?: string;
  ctwaClid?: string;
  gclid?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  trackingCode?: string;
  capturedAt?: number;
}

interface SourceMeta {
  label: string;
  /** Frase da faixa de origem: "Veio do anúncio Meta". */
  phrase: string;
  icon: LucideIcon;
  /** Classe de cor do ícone (tokens do design system). */
  tone: string;
}

const SOURCE_META: Record<string, SourceMeta> = {
  meta_ads: { label: "Meta Ads", phrase: "Veio do anúncio Meta", icon: Facebook, tone: "text-semantic-info" },
  google_ads: { label: "Google Ads", phrase: "Veio do Google Ads", icon: Search, tone: "text-semantic-success" },
  instagram: { label: "Instagram", phrase: "Veio do Instagram", icon: Instagram, tone: "text-brand-400" },
  site: { label: "Site", phrase: "Veio do site", icon: Globe, tone: "text-text-secondary" },
  booking: { label: "Booking", phrase: "Veio do Booking", icon: BedDouble, tone: "text-semantic-info" },
  indicacao: { label: "Indicação", phrase: "Veio por indicação", icon: UserPlus, tone: "text-semantic-success" },
  organico: { label: "Orgânico", phrase: "Contato orgânico", icon: Sprout, tone: "text-text-secondary" },
  retorno: { label: "Cliente de retorno", phrase: "Cliente de retorno", icon: Repeat, tone: "text-brand-400" },
};

export function attributionSourceMeta(source: string | null | undefined): SourceMeta {
  return (
    (source ? SOURCE_META[source] : undefined) ?? {
      label: source ? source.replace(/_/g, " ") : "Origem",
      phrase: "Origem",
      icon: Megaphone,
      tone: "text-text-secondary",
    }
  );
}

/**
 * O que identifica o anúncio/campanha, do mais humano ao mais técnico:
 * título do anúncio → nome da campanha → utm_campaign → termo (Google).
 */
export function attributionDetail(attr: LeadAttribution): string | null {
  const detail =
    attr.adHeadline?.trim() ||
    attr.campaignName?.trim() ||
    attr.utmCampaign?.trim() ||
    attr.utmTerm?.trim() ||
    null;
  return detail || null;
}

/** "abcdef…wxyz" — ids longos de clique (gclid, ctwa_clid) resumidos. */
export function shortId(id: string | null | undefined, keep = 6): string | null {
  if (!id) return null;
  const s = id.trim();
  if (s.length <= keep * 2 + 1) return s;
  return `${s.slice(0, keep)}…${s.slice(-4)}`;
}

const BRL = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 0,
});

export function formatBRL(value: number): string {
  return BRL.format(value);
}

/** "YYYY-MM-DD" → Date local (sem o deslocamento de fuso do `new Date(iso)`). */
function parseDay(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/**
 * Período da estadia em forma curta: "12–15/out", "28/out–02/nov",
 * "12/out" (só check-in). Datas inválidas → null.
 */
export function formatStayRange(checkin?: unknown, checkout?: unknown): string | null {
  const a = typeof checkin === "string" ? parseDay(checkin) : null;
  const b = typeof checkout === "string" ? parseDay(checkout) : null;
  const dd = (d: Date) => String(d.getDate()).padStart(2, "0");
  if (a && b) {
    if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) {
      return `${dd(a)}–${dd(b)}/${MONTHS[a.getMonth()]}`;
    }
    return `${dd(a)}/${MONTHS[a.getMonth()]}–${dd(b)}/${MONTHS[b.getMonth()]}`;
  }
  if (a) return `${dd(a)}/${MONTHS[a.getMonth()]}`;
  return null;
}

/** Noites entre check-in e check-out (null se faltar data ou for inválido). */
export function nightsBetween(checkin: string, checkout: string): number | null {
  const a = parseDay(checkin);
  const b = parseDay(checkout);
  if (!a || !b) return null;
  const nights = Math.round((b.getTime() - a.getTime()) / 86_400_000);
  return nights > 0 ? nights : null;
}

export interface TransferMeta {
  fromDept?: { name: string } | null;
  toDept?: { name: string } | null;
  toMember?: { name: string } | null;
  note?: string | null;
}

/** Destino legível de uma transferência: "Financeiro · Camila". */
export function transferTarget(t: TransferMeta): string {
  return [t.toDept?.name, t.toMember?.name].filter(Boolean).join(" · ") || "outro responsável";
}

/** Converte "#RRGGBB" em rgba com alfa (fundo translúcido de chip). */
export function hexAlpha(hex: string | undefined, alpha: number): string | undefined {
  if (!hex) return undefined;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
