import { plainModelText } from "@/lib/onboardingChat";
import { cn } from "@/lib/utils";

export interface ModelTextProps {
  /** Texto vindo do modelo (ou de qualquer fonte não confiável). */
  text: unknown;
  className?: string;
}

/**
 * Texto do Copiloto como texto PURO: sem HTML, sem imagem e sem link clicável
 * (`plainModelText`), com as quebras de linha preservadas. Nunca use
 * `dangerouslySetInnerHTML` nem `Markdown` para texto do modelo nesta conversa.
 */
export function ModelText({ text, className }: ModelTextProps) {
  const clean = plainModelText(text);
  if (!clean) return null;
  return <p className={cn("whitespace-pre-wrap break-words", className)}>{clean}</p>;
}
