import { Info } from "lucide-react";

/**
 * Bloco de tipo desconhecido (cliente antigo, payload quebrado ou um bloco que
 * falhou ao renderizar). Nunca mostra o conteúdo cru do payload.
 */
export function UnknownBlock() {
  return (
    <p
      role="note"
      className="inline-flex max-w-md items-center gap-1.5 rounded-card border border-dashed border-border px-3 py-2 text-caption text-text-muted"
    >
      <Info className="size-3.5 shrink-0" aria-hidden="true" />
      Este conteúdo não pode ser exibido nesta versão. Atualize a página para ver.
    </p>
  );
}
