import type { FeatureArea } from "../featuresCatalog";
import { FeatureItemCard } from "./FeatureItemCard";

interface FeatureAreaSectionProps {
  area: FeatureArea;
}

/** Uma área do catálogo: ícone, título, resumo e a grade de itens. */
export function FeatureAreaSection({ area }: FeatureAreaSectionProps) {
  const Icon = area.icon;
  const titleId = `${area.id}-titulo`;
  return (
    <section id={area.id} aria-labelledby={titleId} className="scroll-mt-28 py-8 md:scroll-mt-24 md:py-10">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-500/10 text-brand-600">
          <Icon size={22} aria-hidden="true" />
        </span>
        <div>
          <h2 id={titleId} className="font-display text-xl font-bold text-text-primary md:text-2xl">
            {area.title}
          </h2>
          <p className="mt-1 text-sm text-text-secondary md:text-base">{area.summary}</p>
        </div>
      </div>
      <ul className="mt-5 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {area.items.map((item) => (
          <FeatureItemCard key={item.name} item={item} />
        ))}
      </ul>
    </section>
  );
}
