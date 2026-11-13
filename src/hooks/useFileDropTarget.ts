import { useEffect, useRef, useState } from "react";
import { filesFromTransfer, isFileDrag } from "@/lib/composerFiles";

interface UseFileDropTargetArgs {
  /** Elemento que recebe o arrasto (a coluna da conversa). `null` desliga. */
  target: HTMLElement | null;
  /** Chamado ao soltar arquivo(s); quem chama decide o que fazer (validar, avisar). */
  onFiles: (files: File[]) => void;
}

/**
 * Alvo de arrastar-e-soltar arquivo. Só reage a arquivo (texto selecionado,
 * links e elementos da página ficam de fora) e sempre cancela o `drop` de
 * arquivo na área, para o navegador não abrir o arquivo no lugar do app.
 * `dragging` liga o realce "Solte para anexar".
 */
export function useFileDropTarget({ target, onFiles }: UseFileDropTargetArgs): { dragging: boolean } {
  const [dragging, setDragging] = useState(false);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  useEffect(() => {
    if (!target) return;
    // dragenter/dragleave disparam em cada filho: o contador evita o realce piscar.
    let depth = 0;

    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = filesFromTransfer(e.dataTransfer);
      if (files.length > 0) onFilesRef.current(files);
    };
    // Soltar fora da janela ou cancelar com Esc não dispara dragleave no alvo.
    const reset = () => {
      depth = 0;
      setDragging(false);
    };

    target.addEventListener("dragenter", onEnter);
    target.addEventListener("dragover", onOver);
    target.addEventListener("dragleave", onLeave);
    target.addEventListener("drop", onDrop);
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      target.removeEventListener("dragenter", onEnter);
      target.removeEventListener("dragover", onOver);
      target.removeEventListener("dragleave", onLeave);
      target.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
      setDragging(false);
    };
  }, [target]);

  return { dragging };
}
