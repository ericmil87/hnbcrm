import { Link } from "react-router";
import { Quote } from "lucide-react";
import { buttonClassName } from "@/components/ui/Button";
import { AuthorCard } from "../AuthorCard";
import { AUTHOR, MANIFESTO_TEASER } from "../manifestoCopy";
import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";

/** "Quem faz": cartão do autor e o trecho do manifesto com link para o texto completo. */
export function SAuthor() {
  return (
    <LandingSection
      id={LANDING_ANCHORS.author}
      tone="raised"
      eyebrow={AUTHOR.sectionEyebrow}
      title={AUTHOR.sectionTitle}
    >
      <div className="grid grid-cols-1 gap-8 md:grid-cols-2 md:items-start md:gap-12">
        <AuthorCard />
        <div className="flex flex-col items-start md:pt-4">
          <Quote className="size-8 text-brand-600" aria-hidden="true" />
          <blockquote className="mt-3 font-display text-xl font-semibold leading-snug text-text-primary md:text-2xl">
            {MANIFESTO_TEASER.quote}
          </blockquote>
          <Link to="/manifesto" className={buttonClassName("secondary", "lg", "mt-6 w-full sm:w-auto")}>
            {MANIFESTO_TEASER.cta}
          </Link>
        </div>
      </div>
    </LandingSection>
  );
}
