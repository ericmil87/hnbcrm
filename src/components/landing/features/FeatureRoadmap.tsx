import { FEATURE_ROADMAP, FEATURE_STATUS_LABEL } from "../featuresCatalog";
import { FeatureItemCard } from "./FeatureItemCard";

const GROUPS = ["em-liberacao", "em-breve", "no-radar"] as const;

/** Bloco "O que vem depois": o roadmap agrupado por situação. */
export function FeatureRoadmap() {
  return (
    <section id="o-que-vem" aria-labelledby="o-que-vem-titulo" className="scroll-mt-28 py-8 md:scroll-mt-24 md:py-10">
      <h2 id="o-que-vem-titulo" className="font-display text-xl font-bold text-text-primary md:text-2xl">
        O que vem depois
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-text-secondary md:text-base">
        Aqui está o que ainda não existe. Em breve tem plano escrito. No radar está em estudo e pode mudar.
      </p>
      <div className="mt-6 space-y-8">
        {GROUPS.map((status) => {
          const items = FEATURE_ROADMAP.filter((i) => i.status === status);
          if (items.length === 0) return null;
          const id = `roadmap-${status}`;
          return (
            <div key={status} role="group" aria-labelledby={id}>
              <h3 id={id} className="text-base font-semibold text-text-primary">
                {FEATURE_STATUS_LABEL[status]}
              </h3>
              <ul className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {items.map((item) => (
                  <FeatureItemCard key={item.name} item={item} headingLevel="h4" />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
