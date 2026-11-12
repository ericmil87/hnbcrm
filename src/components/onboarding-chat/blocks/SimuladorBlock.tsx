import { PlayCircle } from "lucide-react";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

/**
 * `simulador` — STUB do P3.1. TODO(P3.3): convite ao simulador (indisponível antes do aceite de IA / da aplicação).
 * Até lá mostra só o título e a nota (texto puro), sem nenhuma ação.
 */
export function SimuladorBlock({ block }: BlockProps<"simulador">) {
  return <BlockCard title="Teste a sua IA" icon={PlayCircle} note={block.note} />;
}
