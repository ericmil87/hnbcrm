import { ChevronsDown } from "lucide-react";
import { collapsedBlockLine } from "@/lib/onboardingChat";

/**
 * Cartão que aparece de novo mais abaixo (ou do fluxo antigo): vira uma linha
 * recolhida, sem botões. Só a ocorrência mais recente fica inteira.
 */
export function CollapsedBlock({ kind }: { kind: string }) {
  return (
    <p
      role="note"
      data-collapsed-block={kind}
      className="inline-flex max-w-md items-center gap-1.5 rounded-field border border-dashed border-border-subtle px-3 py-2 text-caption text-text-muted"
    >
      <ChevronsDown className="size-3.5 shrink-0" aria-hidden="true" />
      {collapsedBlockLine(kind)}
    </p>
  );
}
