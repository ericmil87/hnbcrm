/** JSON-LD (schema.org Product + Offer) da página de preços, gerado do catálogo. */
import { PLAN_KEYS, PLANS } from "../../convex/lib/plans";

export function buildPricingJsonLd(siteUrl: string) {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "HNBCRM",
    description: "CRM com atendente de IA, usuários ilimitados e plano por canal e por atendimento IA.",
    url: `${siteUrl}/precos`,
    offers: PLAN_KEYS.map((key) => ({
      "@type": "Offer",
      name: PLANS[key].label,
      price: PLANS[key].monthlyBrl,
      priceCurrency: "BRL",
      url: `${siteUrl}/precos`,
      availability: "https://schema.org/InStock",
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: PLANS[key].monthlyBrl,
        priceCurrency: "BRL",
        unitCode: "MON",
        ...(PLANS[key].perUnitBrl !== undefined && {
          description: "Valor base; mais o preço por unidade contratada.",
        }),
      },
    })),
  };
}
