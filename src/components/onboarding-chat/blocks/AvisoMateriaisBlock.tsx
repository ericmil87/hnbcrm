import { Info } from "lucide-react";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

/**
 * `avisoMateriais` — STUB do P3.1. TODO(P3.2): mostrar `block.text` e o botão de ciência que chama `onboardingChat.ackMaterialsNotice` (clique).
 * Até lá mostra só o título e a nota (texto puro), sem nenhuma ação.
 */
export function AvisoMateriaisBlock({ block }: BlockProps<"avisoMateriais">) {
  return <BlockCard title="Aviso sobre materiais" icon={Info} note={block.note} />;
}
