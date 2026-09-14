/**
 * Preço por mensagem da Cloud API (modelo por mensagem entregue, desde
 * 01/07/2025) — usado só para ESTIMATIVA antes de lançar uma campanha.
 *
 * Valores do Brasil vindos de fontes secundárias convergentes (a Meta só
 * publica o rate card real dentro do painel). Override por env
 * `WA_PRICING_JSON` = {"marketing":0.0625,"utility":0.0068,...}.
 * Bridge (não-oficial) não tem custo por mensagem → 0.
 */

export interface WhatsappPricing {
  marketing: number;
  utility: number;
  authentication: number;
  service: number;
}

export const DEFAULT_PRICING_BR: WhatsappPricing = {
  marketing: 0.0625,
  utility: 0.0068,
  authentication: 0.0068,
  service: 0,
};

export function loadPricing(envJson?: string | null): WhatsappPricing {
  if (!envJson) return DEFAULT_PRICING_BR;
  try {
    const parsed = JSON.parse(envJson) as Partial<WhatsappPricing>;
    return {
      marketing: num(parsed.marketing, DEFAULT_PRICING_BR.marketing),
      utility: num(parsed.utility, DEFAULT_PRICING_BR.utility),
      authentication: num(parsed.authentication, DEFAULT_PRICING_BR.authentication),
      service: num(parsed.service, DEFAULT_PRICING_BR.service),
    };
  } catch {
    return DEFAULT_PRICING_BR;
  }
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function pricePerMessage(
  args: { provider: "meta" | "bridge"; category?: string | null },
  pricing: WhatsappPricing = DEFAULT_PRICING_BR
): number {
  if (args.provider === "bridge") return 0;
  const cat = (args.category ?? "").toUpperCase();
  if (cat === "MARKETING") return pricing.marketing;
  if (cat === "UTILITY") return pricing.utility;
  if (cat === "AUTHENTICATION") return pricing.authentication;
  // texto livre dentro da janela = grátis
  return pricing.service;
}

export function estimateCampaignCost(
  args: { provider: "meta" | "bridge"; category?: string | null; recipients: number },
  pricing: WhatsappPricing = DEFAULT_PRICING_BR
): number {
  const unit = pricePerMessage(args, pricing);
  return Math.round(unit * Math.max(0, args.recipients) * 10000) / 10000;
}
