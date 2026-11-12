import { Languages } from "lucide-react";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

/**
 * `traducaoCartao` — STUB do P3.1. TODO(P3.3): cartão da tradução automática (chave ligada por padrão no rascunho).
 * Até lá mostra só o título e a nota (texto puro), sem nenhuma ação.
 */
export function TraducaoCartaoBlock({ block }: BlockProps<"traducaoCartao">) {
  return <BlockCard title="Atender em outros idiomas" icon={Languages} note={block.note} />;
}
