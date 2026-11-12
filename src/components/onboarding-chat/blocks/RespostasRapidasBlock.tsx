import { MessageSquareText } from "lucide-react";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

/**
 * `respostasRapidas` — STUB do P3.1. TODO(P3.3): atalhos e textos com marcação de revisão.
 * Até lá mostra só o título e a nota (texto puro), sem nenhuma ação.
 */
export function RespostasRapidasBlock({ block }: BlockProps<"respostasRapidas">) {
  return <BlockCard title="Respostas rápidas" icon={MessageSquareText} note={block.note} />;
}
