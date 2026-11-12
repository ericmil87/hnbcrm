import { Link } from "react-router";
import { buttonClassName } from "@/components/ui/Button";
import { FEATURE_HIGHLIGHTS } from "../featuresCatalog";
import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";

/** Resumo das funcionalidades na landing: só o que está pronto. O catálogo completo fica em `/funcionalidades`. */
export function SFeatures() {
  return (
    <LandingSection
      id={LANDING_ANCHORS.features}
      eyebrow="Funcionalidades"
      title="Tudo num lugar só"
      subtitle="O que você precisa para atender, vender e acompanhar, sem juntar cinco ferramentas."
      tone="raised"
    >
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURE_HIGHLIGHTS.map(({ icon: Icon, title, text }) => (
          <li key={title} className="flex flex-col gap-2 rounded-card border border-border bg-surface-base p-4">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-500/10 text-brand-600">
              <Icon size={22} aria-hidden="true" />
            </span>
            <h3 className="text-base font-semibold text-text-primary">{title}</h3>
            <p className="text-sm text-text-secondary">{text}</p>
          </li>
        ))}
      </ul>
      <div className="mt-8 flex justify-center md:justify-start">
        <Link to="/funcionalidades" className={buttonClassName("secondary", "lg")}>
          Ver todas as funcionalidades
        </Link>
      </div>
    </LandingSection>
  );
}
