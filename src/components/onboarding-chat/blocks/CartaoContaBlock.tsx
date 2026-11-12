import { UserCheck } from "lucide-react";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

/**
 * `cartaoConta` — STUB do P3.1. TODO(P3.2): estado do e-mail e confirmação do código (`emailVerification.requestEmailVerificationCode`/`confirmEmailVerificationCode`).
 * Até lá mostra só o título e a nota (texto puro), sem nenhuma ação.
 */
export function CartaoContaBlock({ block }: BlockProps<"cartaoConta">) {
  return <BlockCard title="Sua conta" icon={UserCheck} note={block.note} />;
}
