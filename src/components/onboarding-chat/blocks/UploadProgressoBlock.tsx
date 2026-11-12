import { AlertTriangle, CheckCircle2, FileText, Flag } from "lucide-react";
import { plainModelText } from "@/lib/onboardingChat";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

const SOURCE_LABEL: Record<string, string> = {
  site: "Site",
  pdf: "PDF",
  imagem: "Imagem",
  audio: "Áudio",
};

function count(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

/**
 * `uploadProgresso`: resultado da leitura de UM material (montado pelo
 * servidor): lido/falhou, itens adicionados à base e itens marcados para
 * revisão. Texto sempre puro. Região `role="status"` (leitor de tela anuncia).
 */
export function UploadProgressoBlock({ block }: BlockProps<"uploadProgresso">) {
  const failed = block.status === "falhou";
  const added = Number.isFinite(block.itemsAdded) ? Math.max(0, block.itemsAdded) : 0;
  const flagged = Number.isFinite(block.flagged) ? Math.max(0, block.flagged) : 0;
  const StatusIcon = failed ? AlertTriangle : CheckCircle2;
  return (
    <BlockCard title={`${SOURCE_LABEL[block.sourceKind] ?? "Material"}: leitura`} icon={FileText} note={block.note}>
      <div role="status" className="space-y-1.5">
        <p className="flex items-start gap-2 text-sm text-text-primary">
          <StatusIcon
            className={failed ? "mt-0.5 size-4 shrink-0 text-semantic-warning" : "mt-0.5 size-4 shrink-0 text-semantic-success"}
            aria-hidden="true"
          />
          <span className="min-w-0 break-words">
            <span className="font-medium">{failed ? "Não consegui ler" : "Li"}</span> {plainModelText(block.label)}
          </span>
        </p>
        {failed ? (
          block.message && <p className="text-caption text-text-secondary">{plainModelText(block.message)}</p>
        ) : (
          <p className="text-sm text-text-secondary">
            {added > 0 ? `${count(added, "item adicionado", "itens adicionados")} à base de conhecimento.` : "Nenhum item novo para a base de conhecimento."}
          </p>
        )}
        {!failed && block.message && <p className="text-caption text-text-secondary">{plainModelText(block.message)}</p>}
        {flagged > 0 && (
          <p className="flex items-start gap-1.5 rounded-field bg-semantic-warning/10 px-2 py-1.5 text-caption text-text-primary">
            <Flag className="mt-0.5 size-3.5 shrink-0 text-semantic-warning" aria-hidden="true" />
            <span>
              {count(flagged, "item marcado", "itens marcados")} para você revisar antes de usar.
            </span>
          </p>
        )}
      </div>
    </BlockCard>
  );
}
