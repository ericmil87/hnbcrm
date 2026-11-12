import { Rocket } from "lucide-react";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

/**
 * `aplicarOperacao` — STUB do P3.1. TODO(P3.3): botão que chama `onboardingSessions.applyOnboardingDraft` com `expectedDraftHash`.
 * Até lá mostra só o título e a nota (texto puro), sem nenhuma ação.
 */
export function AplicarOperacaoBlock({ block }: BlockProps<"aplicarOperacao">) {
  return <BlockCard title="Montar minha operação" icon={Rocket} note={block.note} />;
}
