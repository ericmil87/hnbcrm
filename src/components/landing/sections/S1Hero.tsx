import { ArrowDown, ShieldCheck } from "lucide-react";
import { buttonClassName } from "@/components/ui/Button";
import { HeroChat } from "./HeroChat";
import { LANDING_ANCHORS, trustLine } from "./landingCopy";
import { HERO_EYEBROW, HERO_SECONDARY_CTA, HERO_SUBTITLE, HERO_TITLE } from "./S1HeroCopy";

/**
 * Hero: título A (único `<h1>`, elemento de LCP, nunca anima), subtítulo, janela
 * de conversa com o Copiloto e o `Composer` real. Enviar ou tocar num chip guarda
 * a mensagem só no navegador e segue para o onboarding (`goToOnboarding`).
 * Anexo e microfone levam ao mesmo destino com um aviso: não há upload anônimo.
 */
export function S1Hero() {
  return (
    <section
      id={LANDING_ANCHORS.hero}
      aria-labelledby={`${LANDING_ANCHORS.hero}-titulo`}
      className="scroll-mt-28 px-4 pb-14 pt-8 md:scroll-mt-20 md:pb-20 md:pt-16"
    >
      <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-2 lg:items-center lg:gap-12">
        <div className="min-w-0">
          <p className="text-caption font-semibold uppercase tracking-wide text-brand-600">{HERO_EYEBROW}</p>
          <h1
            id={`${LANDING_ANCHORS.hero}-titulo`}
            className="mt-2 font-display text-3xl font-bold leading-tight text-text-primary md:text-5xl"
          >
            {HERO_TITLE}
          </h1>
          <p className="mt-4 text-base text-text-secondary md:text-lg">{HERO_SUBTITLE}</p>
          <div className="mt-6">
            <a href={`#${LANDING_ANCHORS.machine}`} className={buttonClassName("secondary", "lg")}>
              {HERO_SECONDARY_CTA}
              <ArrowDown className="size-4" aria-hidden="true" />
            </a>
          </div>
          <p className="mt-4 flex items-center gap-2 text-sm text-text-muted">
            <ShieldCheck className="size-4 shrink-0 text-brand-600" aria-hidden="true" />
            {trustLine()}
          </p>
        </div>

        <HeroChat />
      </div>
    </section>
  );
}
