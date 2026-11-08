import { useEffect } from "react";
import { toast } from "sonner";

/**
 * Um `?handoff=` que não está na fila (resolvido por outra pessoa, inválido, de outra org) fecha
 * sozinho. Se veio do botão "Assumir" do aviso (`acao=assumir`), avisa. `close` limpa `handoff` e
 * `acao` numa escrita só (`useOpenEntityParam(..., { alsoClear: ["acao"] })`).
 */
export function useCloseGoneHandoff({
  handoffId,
  handoffs,
  acao,
  close,
}: {
  handoffId: string | null;
  handoffs: readonly { _id: string }[] | undefined;
  acao: string | null;
  close: () => void;
}): void {
  useEffect(() => {
    if (!handoffId || handoffs === undefined) return;
    if (handoffs.some((h) => h._id === handoffId)) return;
    if (acao === "assumir") toast.info("Este pedido de ajuda já foi assumido ou resolvido.");
    close();
  }, [handoffs, handoffId, close, acao]);
}
