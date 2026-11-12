import { useState } from "react";
import { Languages } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { setTranslation } from "@/lib/onboardingDraftEdit";
import { VOCAB } from "@/lib/vocab";
import { buildBlock } from "../../../../convex/lib/onboardingBlocks";
import { liveBlockContext, useDraftEditor } from "../useDraftEditor";
import { purposeOf } from "./ApprovableCard";
import { BlockCard } from "./BlockCard";
import type { CardEditor } from "./draftParts";
import type { BlockOf, BlockProps } from "./types";

export interface TraducaoCartaoViewProps {
  block: BlockOf<"traducaoCartao">;
  compact?: boolean;
  editor?: CardEditor;
  /** Sem `editor`: a chave só pede para carregar o rascunho vivo. */
  onAdjust?: () => void;
}

/**
 * `traducaoCartao`: a tradução automática vem ligada no rascunho de contas
 * novas; a chave grava `features.translation` pelo `saveDraft` (nada é
 * aplicado antes de "Montar minha operação").
 */
export function TraducaoCartaoView({ block, compact, editor, onAdjust }: TraducaoCartaoViewProps) {
  const label = block.enabled ? "Ligada" : "Desligada";
  return (
    <BlockCard title={VOCAB.translation.name} icon={Languages} purpose={purposeOf(block)} note={compact ? undefined : block.note}>
      {!block.enabled && <p className="text-text-secondary">Desligada: as mensagens aparecem como o cliente escreveu.</p>}
      {!compact && (
        <p className="mt-1 text-caption text-text-muted">Funciona depois do aceite de IA. Dá para mudar quando quiser, em Configurações.</p>
      )}
      <div className="mt-2">
        {editor ? (
          <Switch
            label={`${VOCAB.translation.name}: ${label.toLowerCase()}`}
            checked={block.enabled}
            disabled={editor.saving}
            onCheckedChange={(next) => void editor.save(setTranslation(next), editor.version)}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-caption font-medium text-text-primary">{label}</p>
            {onAdjust && (
              <Button size="sm" variant="secondary" onClick={onAdjust}>
                Ajustar
              </Button>
            )}
          </div>
        )}
      </div>
    </BlockCard>
  );
}

function TraducaoLive({ block, ctx }: BlockProps<"traducaoCartao">) {
  const ed = useDraftEditor(ctx);
  const live = ed.draft
    ? (buildBlock({ kind: "traducaoCartao", note: block.note }, liveBlockContext(ed)) as BlockOf<"traducaoCartao"> | null)
    : null;
  return (
    <TraducaoCartaoView
      block={live ?? block}
      compact={ctx.compact}
      editor={ed.draft ? { version: ed.version, saving: ed.saving, save: ed.save } : undefined}
    />
  );
}

export function TraducaoCartaoBlock({ block, ctx }: BlockProps<"traducaoCartao">) {
  const [live, setLive] = useState(false);
  if (live) return <TraducaoLive block={block} ctx={ctx} />;
  return <TraducaoCartaoView block={block} compact={ctx.compact} onAdjust={ctx.organizationId ? () => setLive(true) : undefined} />;
}
