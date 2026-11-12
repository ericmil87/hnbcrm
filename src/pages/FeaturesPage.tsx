import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import { SEO } from "@/components/SEO";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { Button, buttonClassName } from "@/components/ui/Button";
import { Footer } from "@/components/landing/Footer";
import { PublicThemeButton } from "@/components/landing/PublicThemeButton";
import { FeatureAreaSection } from "@/components/landing/features/FeatureAreaSection";
import { FeatureRoadmap } from "@/components/landing/features/FeatureRoadmap";
import { FeatureStatusLegend } from "@/components/landing/features/FeatureStatusLegend";
import { FEATURE_AREAS } from "@/components/landing/featuresCatalog";
import { PRIMARY_CTA_LABEL, trustLine } from "@/components/landing/sections/landingCopy";
import { startHref } from "@/lib/onboardingEntry";

const SITE_URL = import.meta.env.VITE_SITE_URL || "https://hnbcrm.com";

const SEO_DESCRIPTION =
  "Veja o que o HNBCRM já faz hoje, o que vem desligado e o que ainda não existe: conversas, WhatsApp, Atendente IA, funil, campanhas e API.";

const chipClass =
  "inline-flex min-h-11 shrink-0 items-center rounded-full border border-border bg-surface-raised px-4 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base";

export function FeaturesPage() {
  return (
    <div className="min-h-screen bg-surface-base text-text-primary">
      <SEO
        title="Funcionalidades do HNBCRM: tudo o que já funciona e o que vem aí"
        description={SEO_DESCRIPTION}
        canonical={`${SITE_URL}/funcionalidades`}
      />
      <header className="px-4 pt-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-2">
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
            <Link to="/entrar" className="hidden sm:block">
              <Button variant="ghost" size="sm">
                Entrar
              </Button>
            </Link>
            <Link to={startHref()} className={buttonClassName("primary", "sm", "shrink-0 whitespace-nowrap")}>
              {PRIMARY_CTA_LABEL}
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 pb-16 pt-10 md:pt-14">
        <h1 className="max-w-3xl font-display text-3xl font-bold text-text-primary md:text-5xl">
          Tudo o que o HNBCRM faz hoje, e o que vem depois
        </h1>
        <p className="mt-4 max-w-2xl text-base text-text-secondary md:text-lg">
          Sem letra miúda: o que está pronto está marcado como pronto. O que ainda não existe está no fim da página, com o nome certo.
        </p>

        <div className="mt-8">
          <FeatureStatusLegend />
        </div>

        <nav
          aria-label="Áreas"
          className="-mx-4 mt-8 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:mx-0 md:flex-wrap md:overflow-visible md:px-0 [&::-webkit-scrollbar]:hidden"
        >
          {FEATURE_AREAS.map((area) => (
            <a key={area.id} href={`#${area.id}`} className={chipClass}>
              {area.title}
            </a>
          ))}
          <a href="#o-que-vem" className={chipClass}>
            O que vem depois
          </a>
        </nav>

        <div className="mt-4 divide-y divide-border-subtle">
          {FEATURE_AREAS.map((area) => (
            <FeatureAreaSection key={area.id} area={area} />
          ))}
        </div>

        <div className="mt-4 border-t border-border-subtle">
          <FeatureRoadmap />
        </div>

        <section aria-labelledby="funcionalidades-cta" className="mt-10 rounded-card border border-border bg-surface-raised p-6 text-center md:p-10">
          <h2 id="funcionalidades-cta" className="font-display text-xl font-bold text-text-primary md:text-3xl">
            Veja funcionando no seu negócio
          </h2>
          <div className="mt-5 flex justify-center">
            <Link to={startHref()} className={buttonClassName("primary", "lg")}>
              {PRIMARY_CTA_LABEL}
            </Link>
          </div>
          <p className="mt-3 text-sm text-text-secondary">{trustLine()}</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-6">
            <Link to="/precos" className="inline-flex min-h-11 items-center text-sm font-medium text-text-secondary underline underline-offset-2 hover:text-text-primary">
              Ver preços
            </Link>
            <Link to="/manifesto" className="inline-flex min-h-11 items-center text-sm font-medium text-text-secondary underline underline-offset-2 hover:text-text-primary">
              Ler o manifesto
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
