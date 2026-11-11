import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import { Helmet } from "react-helmet-async";
import { SEO } from "@/components/SEO";
import { Button } from "@/components/ui/Button";
import { Footer } from "@/components/landing/Footer";
import { PricingSection } from "@/components/landing/pricing/PricingSection";
import { formatMoney } from "@/lib/format";
import { buildPricingJsonLd } from "@/lib/pricingJsonLd";
import { PLANS } from "../../convex/lib/plans";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { PublicThemeButton } from "@/components/landing/PublicThemeButton";

const SITE_URL = import.meta.env.VITE_SITE_URL || "https://hnbcrm.com";

export function PricingPage() {
  const from = formatMoney(PLANS.essencial.monthlyBrl, "BRL", { fractionDigits: 0 });
  return (
    <div className="min-h-screen bg-surface-base text-text-primary">
      <SEO
        title={`Preços — a partir de ${from}/mês, usuários ilimitados`}
        description="Planos do HNBCRM por canal e por atendimento IA. Usuários ilimitados, teste de 30 dias sem cartão e excedente só se você ligar, com teto."
        canonical={`${SITE_URL}/precos`}
      />
      <Helmet>
        <script type="application/ld+json">{JSON.stringify(buildPricingJsonLd(SITE_URL))}</script>
      </Helmet>
      <header className="px-4 pt-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <Link to="/" className="flex min-h-11 items-center gap-2">
            <BrandLogo variant="wordmark" size="md" />
          </Link>
          <div className="flex items-center gap-1 sm:gap-2">
            <PublicThemeButton />
            <Link to="/">
              <Button variant="ghost" size="sm">
                <ArrowLeft size={16} />
                <span className="sm:hidden">Voltar</span>
                <span className="hidden sm:inline">Voltar ao início</span>
              </Button>
            </Link>
            <Link to="/entrar">
              <Button variant="ghost" size="sm">
                Entrar
              </Button>
            </Link>
          </div>
        </div>
      </header>
      <main>
        <h1 className="sr-only">Preços do HNBCRM</h1>
        <PricingSection variant="page" />
      </main>
      <Footer />
    </div>
  );
}
