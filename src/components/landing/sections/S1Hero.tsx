import { Link } from "react-router";
import { buttonClassName } from "@/components/ui/Button";
import { signUpHref } from "@/lib/authEntry";
import { LANDING_ANCHORS, PRIMARY_CTA_LABEL, trustLine } from "./landingCopy";

/**
 * Placeholder estrutural (P1.1): o único `<h1>` da página (título A da copy
 * aprovada), subtítulo, CTAs e linha de confiança. O título é o elemento de
 * LCP e nunca anima.
 * P1.2: janela do Copiloto com `Composer` (placeholder rotativo), chips e
 * microaviso, vindos de `src/components/landing/kit/`.
 */
export function S1Hero() {
  return (
    <section
      id={LANDING_ANCHORS.hero}
      aria-labelledby={`${LANDING_ANCHORS.hero}-titulo`}
      className="scroll-mt-28 px-4 pb-14 pt-8 md:scroll-mt-20 md:pb-20 md:pt-16"
    >
      <div className="mx-auto max-w-6xl">
        <div className="max-w-3xl">
          <p className="text-caption font-semibold uppercase tracking-wide text-brand-600">Humanos e IAs no mesmo time</p>
          <h1
            id={`${LANDING_ANCHORS.hero}-titulo`}
            className="mt-2 font-display text-3xl font-bold leading-tight text-text-primary md:text-5xl"
          >
            Conte como é o seu negócio. Em minutos, sua IA já atende no WhatsApp.
          </h1>
          <p className="mt-4 text-base text-text-secondary md:text-lg">
            Converse com o Copiloto, veja a sua operação nascer e teste a sua IA antes de conectar um número.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link to={signUpHref()} className={buttonClassName("primary", "lg")}>
              {PRIMARY_CTA_LABEL}
            </Link>
            <a href={`#${LANDING_ANCHORS.machine}`} className={buttonClassName("secondary", "lg")}>
              Ver como funciona
            </a>
          </div>
          <p className="mt-4 text-sm text-text-muted">{trustLine()}</p>
        </div>
      </div>
    </section>
  );
}
