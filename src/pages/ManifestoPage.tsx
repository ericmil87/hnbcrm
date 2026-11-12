import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import { SEO } from "@/components/SEO";
import { Button, buttonClassName } from "@/components/ui/Button";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { AuthorCard } from "@/components/landing/AuthorCard";
import { Footer } from "@/components/landing/Footer";
import { NewsletterForm } from "@/components/landing/NewsletterForm";
import { PublicThemeButton } from "@/components/landing/PublicThemeButton";
import {
  MANIFESTO_CHAPTERS,
  MANIFESTO_CLOSING,
  MANIFESTO_EYEBROW,
  MANIFESTO_LEAD,
  MANIFESTO_SEO,
  MANIFESTO_SIGNATURE,
  MANIFESTO_TITLE,
} from "@/components/landing/manifestoCopy";
import { PRIMARY_CTA_LABEL, trustLine } from "@/components/landing/sections/landingCopy";
import { startHref } from "@/lib/onboardingEntry";

const SITE_URL = import.meta.env.VITE_SITE_URL || "https://hnbcrm.com";

/** `/manifesto`: texto longo para ler, assinado pelo autor. Página pública, sem Convex. */
export function ManifestoPage() {
  return (
    <div className="min-h-screen bg-surface-base text-text-primary">
      <SEO
        title={MANIFESTO_SEO.title}
        description={MANIFESTO_SEO.description}
        canonical={`${SITE_URL}/manifesto`}
        ogType="article"
        preloadDisplayFont
      />
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
      <main className="px-4 pb-20 pt-12 md:pt-16">
        <article className="mx-auto max-w-2xl">
          <header>
            <p className="text-caption font-semibold uppercase tracking-wide text-brand-600">{MANIFESTO_EYEBROW}</p>
            <h1 className="mt-2 font-display text-3xl font-bold leading-tight text-text-primary md:text-5xl">
              {MANIFESTO_TITLE}
            </h1>
            <p className="mt-6 text-lg leading-relaxed text-text-secondary md:text-xl">{MANIFESTO_LEAD}</p>
          </header>

          {MANIFESTO_CHAPTERS.map((chapter) => (
            <section key={chapter.id} aria-labelledby={chapter.id} className="mt-14 md:mt-20">
              <h2
                id={chapter.id}
                className="scroll-mt-24 font-display text-2xl font-bold leading-snug text-text-primary md:text-3xl"
              >
                {chapter.title}
              </h2>
              <div className="mt-5 space-y-5 text-base leading-relaxed text-text-primary md:text-lg">
                {chapter.paragraphs.map((p) => (
                  <p key={p}>{p}</p>
                ))}
              </div>
            </section>
          ))}

          <div className="mt-16 border-t border-border pt-12 md:mt-24 md:pt-16">
            <p className="font-display text-2xl font-bold leading-snug text-text-primary md:text-4xl">
              {MANIFESTO_CLOSING}
            </p>
            <p className="mt-6 text-base text-text-secondary md:text-lg">{MANIFESTO_SIGNATURE}</p>
          </div>
        </article>

        <div className="mx-auto mt-16 max-w-2xl space-y-12 md:mt-20">
          <AuthorCard className="bg-surface-raised" />

          <section aria-labelledby="manifesto-novidades" className="rounded-card border border-border bg-surface-raised p-5 md:p-6">
            <h2 id="manifesto-novidades" className="font-display text-xl font-bold text-text-primary md:text-2xl">
              Receba as novidades
            </h2>
            <div className="mt-4">
              <NewsletterForm source="manifesto" />
            </div>
          </section>

          <section aria-label="Experimente o HNBCRM" className="text-center">
            <Link to={startHref()} className={buttonClassName("primary", "lg", "w-full sm:w-auto")}>
              {PRIMARY_CTA_LABEL}
            </Link>
            <p className="mt-3 text-sm text-text-muted">{trustLine()}</p>
            <Link
              to="/funcionalidades"
              className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-brand-400 underline-offset-4 hover:underline"
            >
              Ver todas as funcionalidades
            </Link>
          </section>
        </div>
      </main>
      <Footer />
    </div>
  );
}
