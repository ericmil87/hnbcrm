import { cn } from "@/lib/utils";

type LineKind = "label" | "remove" | "add" | "plain";

function classify(line: string): LineKind {
  if (/^(Antes|Depois):/.test(line)) return "label";
  if (line.startsWith("- ")) return "remove";
  if (line.startsWith("+ ")) return "add";
  return "plain";
}

const KIND_CLASS: Record<LineKind, string> = {
  label: "font-semibold text-text-primary",
  remove: "text-semantic-error",
  add: "text-semantic-success",
  plain: "text-text-secondary",
};

/**
 * Prévia "Antes → Depois" de uma confirmação do Copiloto. Texto puro (nunca
 * HTML), quebras de linha preservadas; só cor e prefixo distinguem o diff.
 */
export function ConfigPreview({ preview, className }: { preview: string; className?: string }) {
  const lines = preview.split("\n");
  return (
    <div className={cn("text-sm whitespace-pre-wrap break-words", className)}>
      {lines.map((line, i) => {
        const kind = classify(line);
        return (
          <div key={i} data-kind={kind} className={KIND_CLASS[kind]}>
            {line === "" ? " " : line}
          </div>
        );
      })}
    </div>
  );
}
