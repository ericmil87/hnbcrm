import { Smartphone } from "lucide-react";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

/**
 * `conectarCanal` — STUB do P3.1. TODO(P3.3): leva ao `ChannelConnectCard` (nunca refazer o pareamento aqui).
 * Até lá mostra só o título e a nota (texto puro), sem nenhuma ação.
 */
export function ConectarCanalBlock({ block }: BlockProps<"conectarCanal">) {
  return <BlockCard title="Conectar o WhatsApp" icon={Smartphone} note={block.note} />;
}
