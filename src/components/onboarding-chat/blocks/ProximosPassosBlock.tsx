import { ListChecks } from "lucide-react";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

/**
 * `proximosPassos` — STUB do P3.1. TODO(P3.3): lista `steps` com os destinos de cada passo.
 * Até lá mostra só o título e a nota (texto puro), sem nenhuma ação.
 */
export function ProximosPassosBlock({ block }: BlockProps<"proximosPassos">) {
  return <BlockCard title="Próximos passos" icon={ListChecks} note={block.note} />;
}
