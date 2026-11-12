import { BookOpen } from "lucide-react";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

/**
 * `conhecimentoLista` — STUB do P3.1. TODO(P3.3): itens com origem, marcados para revisão e "Liberar mesmo assim" (`onboardingSessions.saveDraft`).
 * Até lá mostra só o título e a nota (texto puro), sem nenhuma ação.
 */
export function ConhecimentoListaBlock({ block }: BlockProps<"conhecimentoLista">) {
  return <BlockCard title="O que ele sabe" icon={BookOpen} note={block.note} />;
}
