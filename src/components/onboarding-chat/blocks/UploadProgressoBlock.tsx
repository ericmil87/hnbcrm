import { FileText } from "lucide-react";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

/**
 * `uploadProgresso` — STUB do P3.1. TODO(P3.2): resultado da leitura (`status`, `itemsAdded`, `flagged`, `message`).
 * Até lá mostra só o título e a nota (texto puro), sem nenhuma ação.
 */
export function UploadProgressoBlock({ block }: BlockProps<"uploadProgresso">) {
  return <BlockCard title="Leitura do material" icon={FileText} note={block.note} />;
}
