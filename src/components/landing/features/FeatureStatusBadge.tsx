import { Badge } from "@/components/ui/Badge";
import { FEATURE_STATUS_LABEL, type FeatureStatus } from "../featuresCatalog";

const VARIANT: Record<Exclude<FeatureStatus, "pronto">, "default" | "warning" | "info"> = {
  opcional: "default",
  "em-liberacao": "warning",
  "em-breve": "info",
  "no-radar": "default",
};

interface FeatureStatusBadgeProps {
  status: FeatureStatus;
  className?: string;
}

/** Selo da situação de uma funcionalidade. "Pronto" não leva selo (o padrão não polui a lista). */
export function FeatureStatusBadge({ status, className }: FeatureStatusBadgeProps) {
  if (status === "pronto") return null;
  return (
    <Badge variant={VARIANT[status]} className={className}>
      {FEATURE_STATUS_LABEL[status]}
    </Badge>
  );
}
