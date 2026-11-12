import { Bot } from "lucide-react";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

/**
 * `personaCard` — STUB do P3.1. TODO(P3.3): nome, tom, tratamento, idiomas e saudação com "Ajustar".
 * Até lá mostra só o título e a nota (texto puro), sem nenhuma ação.
 */
export function PersonaCardBlock({ block }: BlockProps<"personaCard">) {
  return <BlockCard title="Seu atendente" icon={Bot} note={block.note} />;
}
