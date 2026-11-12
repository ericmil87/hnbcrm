import { featureStatus, type FeatureItem } from "../featuresCatalog";
import { FeatureStatusBadge } from "./FeatureStatusBadge";

interface FeatureItemCardProps {
  item: FeatureItem;
  /** Nível do título do item (h3 sob uma área, h4 sob um grupo do roadmap). */
  headingLevel?: "h3" | "h4";
}

/** Cartão de uma funcionalidade: nome em destaque, frase e, se não for "pronto", o selo. */
export function FeatureItemCard({ item, headingLevel: Heading = "h3" }: FeatureItemCardProps) {
  const status = featureStatus(item);
  return (
    <li className="flex flex-col gap-1.5 rounded-card border border-border bg-surface-raised p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Heading className="text-base font-semibold text-text-primary">{item.name}</Heading>
        <FeatureStatusBadge status={status} className="shrink-0" />
      </div>
      <p className="text-sm text-text-secondary">{item.text}</p>
    </li>
  );
}
