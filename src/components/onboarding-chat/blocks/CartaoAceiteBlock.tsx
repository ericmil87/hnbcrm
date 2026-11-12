import { ShieldCheck } from "lucide-react";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

/**
 * `cartaoAceite` — STUB do P3.1. TODO(P3.2): convite ao aceite de IA/LGPD; o clique chama `aiSettings.setAiEnabled` (nunca automático).
 * Até lá mostra só o título e a nota (texto puro), sem nenhuma ação.
 */
export function CartaoAceiteBlock({ block }: BlockProps<"cartaoAceite">) {
  return <BlockCard title="Ativar a IA" icon={ShieldCheck} note={block.note} />;
}
