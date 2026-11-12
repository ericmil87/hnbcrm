import { AlertTriangle, Building2, MapPin } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { plainModelText } from "@/lib/onboardingChat";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

/** `resumoNegocio`: nome, segmento, descrição e cidade do rascunho (P3.3 acrescenta "Ajustar"). */
export function ResumoNegocioBlock({ block }: BlockProps<"resumoNegocio">) {
  const name = plainModelText(block.name) || "Seu negócio";
  const description = plainModelText(block.description);
  const city = plainModelText(block.city);
  return (
    <BlockCard title="Resumo do negócio" icon={Building2} note={block.note}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 break-words font-semibold">{name}</p>
        {block.segmentLabel && <Badge variant="brand">{plainModelText(block.segmentLabel)}</Badge>}
      </div>
      {description && <p className="mt-1 whitespace-pre-wrap break-words text-text-secondary">{description}</p>}
      {city && (
        <p className="mt-1 inline-flex items-center gap-1 text-caption text-text-muted">
          <MapPin className="size-3.5" aria-hidden="true" />
          {city}
        </p>
      )}
      {block.suspicious && (
        <p className="mt-2 flex items-start gap-1.5 rounded-field bg-semantic-warning/10 px-2 py-1.5 text-caption text-text-primary">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-semantic-warning" aria-hidden="true" />
          Este resumo tem um trecho marcado para revisão antes de entrar na operação.
        </p>
      )}
    </BlockCard>
  );
}
