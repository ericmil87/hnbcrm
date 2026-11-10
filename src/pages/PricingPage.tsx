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

const SITE_URL = import.meta.env.VITE_SITE_URL || "https://hnbcrm.com";

export function PricingPage() {
  const from = formatMoney(PLANS.essencial.monthlyBrl, "BRL", { fractionDigits: 0 });
  return (
    <div className="min-h-screen bg-surface-base text-text-primary">
      <SEO
        title={`Preços — a partir de ${from}/mês, usuários ilimitados`}
        description="Planos do HNBCRM por canal e por atendimento IA. Usuários ilimitados, teste de 30 dias sem cartão e excedente só se você ligar, com teto."
        keywords="preço crm whatsapp, crm com ia preço, crm usuários ilimitados"
        canonical={`${SITE_URL}/precos`}
      />
      <Helmet>
        <script type="application/ld+json">{JSON.stringify(buildPricingJsonLd(SITE_URL))}</script>
      </Helmet>
      <header className="px-4 pt-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <Link to="/" className="flex min-h-11 items-center gap-2">
            <img
              src="/black_icon_logo_transparent-bg-528x488.png"
              alt="HNBCRM Logo"
              className="h-8 w-8 object-contain"
            />
            <span className="text-xl font-bold text-text-primary">HNBCRM</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link to="/">
              <Button variant="ghost" size="sm">
                <ArrowLeft size={16} />
                Voltar ao início
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
