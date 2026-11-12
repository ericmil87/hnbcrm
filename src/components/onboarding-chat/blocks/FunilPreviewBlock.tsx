import { AlertTriangle, Columns3 } from "lucide-react";
import { plainModelText } from "@/lib/onboardingChat";
import { cn } from "@/lib/utils";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

const OUTCOME_CLASS: Record<string, string> = {
  won: "border-semantic-success/60 bg-semantic-success/10",
  lost: "border-semantic-error/40 bg-semantic-error/5",
  open: "border-border bg-surface-sunken",
};

/**
 * `funilPreview` (simples): nome do funil, etapas em sequência e campos. As
 * colunas entram em sequência só com movimento permitido (`motion-safe:`). O
 * funil animado com cartões é do P3.3.
 */
export function FunilPreviewBlock({ block }: BlockProps<"funilPreview">) {
  const stages = Array.isArray(block.stages) ? block.stages.slice(0, 12) : [];
  const fields = Array.isArray(block.customFields) ? block.customFields.slice(0, 12) : [];
  return (
    <BlockCard title={plainModelText(block.funnelName) || "Funil"} icon={Columns3} note={block.note}>
      <ol className="flex gap-1.5 overflow-x-auto pb-1" aria-label="Etapas do funil">
        {stages.map((s, i) => (
          <li
            key={`${i}:${s.name}`}
            className={cn(
              "min-w-24 shrink-0 rounded-field border px-2 py-1.5 text-caption font-medium motion-safe:animate-scene-in",
              OUTCOME_CLASS[s.outcome] ?? OUTCOME_CLASS.open
            )}
            style={{ animationDelay: `${i * 80}ms` }}
          >
            <span className="tabular-nums text-text-muted">{i + 1}.</span> {plainModelText(s.name)}
          </li>
        ))}
      </ol>
      {fields.length > 0 && (
        <p className="mt-2 text-caption text-text-secondary">
          Campos: {fields.map((f) => plainModelText(f.name)).filter(Boolean).join(", ")}
        </p>
      )}
      {block.blockedCount > 0 && (
        <p className="mt-2 flex items-start gap-1.5 rounded-field bg-semantic-warning/10 px-2 py-1.5 text-caption text-text-primary">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-semantic-warning" aria-hidden="true" />
          <span>
            <span className="tabular-nums">{block.blockedCount}</span>{" "}
            {block.blockedCount === 1 ? "nome precisa" : "nomes precisam"} ser editado(s) antes de montar a operação.
          </span>
        </p>
      )}
    </BlockCard>
  );
}
