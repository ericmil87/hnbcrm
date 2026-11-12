import { useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Columns3, SlidersHorizontal } from "lucide-react";
import { MiniFunnel } from "@/components/landing/kit";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { plainModelText } from "@/lib/onboardingChat";
import { moveStage, renameStage, setFunnelName } from "@/lib/onboardingDraftEdit";
import { cn } from "@/lib/utils";
import { buildBlock } from "../../../../convex/lib/onboardingBlocks";
import { DRAFT_LIMITS, type OnboardingDraft } from "../../../../convex/lib/onboardingDraft";
import { liveBlockContext, useDraftEditor } from "../useDraftEditor";
import { BlockCard } from "./BlockCard";
import { BlockedNotice, FormActions, StaleNotice, useBaseVersion, type CardEditor } from "./draftParts";
import type { BlockOf, BlockProps } from "./types";

const OUTCOME_CLASS: Record<string, string> = {
  won: "border-semantic-success/60 bg-semantic-success/10",
  lost: "border-semantic-error/40 bg-semantic-error/5",
  open: "border-border bg-surface-sunken",
};
const OUTCOME_LABEL: Record<string, string> = { won: "Ganho", lost: "Perdido" };

/** Largura mínima de cada coluna do funil animado (rola na horizontal em tela estreita). */
const COLUMN_MIN_PX = 104;

export interface FunilPreviewViewProps {
  block: BlockOf<"funilPreview">;
  compact?: boolean;
  editor?: CardEditor;
  /** Textos estruturais bloqueados (só com o rascunho vivo): pedem edição, sem liberação. */
  blocked?: OnboardingDraft["blocked"];
  onAdjust?: () => void;
  startOpen?: boolean;
}

/**
 * `funilPreview`: o funil em colunas (`MiniFunnel`), entrando em sequência
 * (movimento reduzido = estado final), com "Ajustar" para os nomes e a ordem
 * das etapas. Nome bloqueado pede edição; não existe "usar mesmo assim" aqui.
 */
export function FunilPreviewView({ block, compact, editor, blocked, onAdjust, startOpen = false }: FunilPreviewViewProps) {
  const [open, setOpen] = useState(startOpen);
  const stages = Array.isArray(block.stages) ? block.stages.slice(0, 12) : [];
  const fields = Array.isArray(block.customFields) ? block.customFields.slice(0, 12) : [];
  const columns = stages.map((s, i) => ({ id: String(i), title: plainModelText(s.name) }));
  const cards = columns.length > 0 ? [{ id: "primeiro", title: "Primeiro contato", subtitle: "Exemplo", columnId: "0" }] : [];

  return (
    <BlockCard title={plainModelText(block.funnelName) || "Funil"} icon={Columns3} note={compact ? undefined : block.note}>
      {compact ? (
        <ol className="flex flex-wrap gap-1.5" aria-label="Etapas do funil">
          {stages.map((s, i) => (
            <li
              key={`${i}:${s.name}`}
              className={cn("rounded-field border px-2 py-1 text-caption font-medium", OUTCOME_CLASS[s.outcome] ?? OUTCOME_CLASS.open)}
            >
              <span className="tabular-nums text-text-muted">{i + 1}.</span> {plainModelText(s.name)}
            </li>
          ))}
        </ol>
      ) : (
        <div className="overflow-x-auto pb-1">
          <div style={{ minWidth: columns.length * COLUMN_MIN_PX }}>
            <MiniFunnel label="Etapas do funil" columns={columns} cards={cards} enter staggerMs={110} />
          </div>
        </div>
      )}
      {!compact && stages.some((s) => OUTCOME_LABEL[s.outcome]) && (
        <p className="mt-1 text-caption text-text-muted">
          {stages
            .filter((s) => OUTCOME_LABEL[s.outcome])
            .map((s) => `${plainModelText(s.name)}: ${OUTCOME_LABEL[s.outcome].toLowerCase()}`)
            .join(" · ")}
        </p>
      )}
      {fields.length > 0 && !compact && (
        <p className="mt-2 text-caption text-text-secondary">
          Campos: {fields.map((f) => plainModelText(f.name)).filter(Boolean).join(", ")}
        </p>
      )}
      {block.blockedCount > 0 && (
        <div className="mt-2 space-y-1.5">
          <p className="flex items-start gap-1.5 rounded-field bg-semantic-warning/10 px-2 py-1.5 text-caption text-text-primary">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-semantic-warning" aria-hidden="true" />
            <span>
              <span className="tabular-nums">{block.blockedCount}</span>{" "}
              {block.blockedCount === 1 ? "nome precisa" : "nomes precisam"} ser editado(s) antes de montar a operação.
            </span>
          </p>
          {blocked && blocked.length > 0 && !compact && (
            <ul className="space-y-1.5">
              {blocked.map((b) => (
                <BlockedNotice key={b.field} label={b.label} reason={b.reason} />
              ))}
            </ul>
          )}
        </div>
      )}

      {open && editor ? (
        <FunnelForm block={block} editor={editor} onClose={() => setOpen(false)} />
      ) : (
        (editor || onAdjust) && (
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => (editor ? setOpen(true) : onAdjust?.())}>
            <SlidersHorizontal className="size-3.5" aria-hidden="true" />
            Ajustar
          </Button>
        )
      )}
    </BlockCard>
  );
}

function FunnelForm({ block, editor, onClose }: { block: BlockOf<"funilPreview">; editor: CardEditor; onClose: () => void }) {
  const [name, setName] = useState(block.funnelName);
  const [stageNames, setStageNames] = useState(() => block.stages.map((s) => s.name));
  const [order, setOrder] = useState(() => block.stages.map((_, i) => i));
  const { base, stale, reload } = useBaseVersion(editor.version, () => {
    setName(block.funnelName);
    setStageNames(block.stages.map((s) => s.name));
    setOrder(block.stages.map((_, i) => i));
  });

  const move = (pos: number, dir: -1 | 1) => {
    const target = pos + dir;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[pos], next[target]] = [next[target], next[pos]];
    setOrder(next);
  };
  const empty = name.trim() === "" || order.some((o) => stageNames[o].trim() === "");

  const save = () => {
    // Renomeia pelas posições originais, depois reordena (cada passo parte do resultado do anterior).
    const renames = stageNames.map((n, i) => renameStage(i, n.trim()));
    const moves: ReturnType<typeof moveStage>[] = [];
    const cur = block.stages.map((_, i) => i);
    for (let target = 0; target < order.length; target += 1) {
      const from = cur.indexOf(order[target]);
      for (let p = from; p > target; p -= 1) {
        moves.push(moveStage(p, -1));
        [cur[p], cur[p - 1]] = [cur[p - 1], cur[p]];
      }
    }
    const update = (d: OnboardingDraft) =>
      [...renames, ...moves].reduce((acc, fn) => fn(acc), setFunnelName(name.trim())(d));
    void editor.save(update, base).then((ok) => ok && onClose());
  };

  return (
    <div className="mt-2 space-y-3 rounded-field border border-border-subtle bg-surface-sunken p-2">
      <Input label="Nome do funil" value={name} maxLength={DRAFT_LIMITS.funnelName} onChange={(e) => setName(e.target.value)} />
      <ol className="space-y-2" aria-label="Editar etapas">
        {order.map((original, pos) => (
          <li key={original} className="flex items-end gap-1.5">
            <div className="min-w-0 flex-1">
              <Input
                label={`Etapa ${pos + 1}`}
                value={stageNames[original]}
                maxLength={DRAFT_LIMITS.stageName}
                onChange={(e) => setStageNames((prev) => prev.map((n, i) => (i === original ? e.target.value : n)))}
              />
            </div>
            <Button
              iconOnly
              size="sm"
              variant="secondary"
              aria-label={`Subir a etapa ${pos + 1}`}
              disabled={pos === 0}
              onClick={() => move(pos, -1)}
            >
              <ArrowUp className="size-4" aria-hidden="true" />
            </Button>
            <Button
              iconOnly
              size="sm"
              variant="secondary"
              aria-label={`Descer a etapa ${pos + 1}`}
              disabled={pos === order.length - 1}
              onClick={() => move(pos, 1)}
            >
              <ArrowDown className="size-4" aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ol>
      <StaleNotice stale={stale} onReload={reload} />
      <FormActions saving={editor.saving} saveDisabled={empty || stale} onCancel={onClose} onSave={save} />
    </div>
  );
}

function FunilLive({ block, ctx }: BlockProps<"funilPreview">) {
  const ed = useDraftEditor(ctx);
  const live = ed.draft
    ? (buildBlock({ kind: "funilPreview", note: block.note }, liveBlockContext(ed)) as BlockOf<"funilPreview"> | null)
    : null;
  return (
    <FunilPreviewView
      block={live ?? block}
      compact={ctx.compact}
      blocked={ed.draft?.blocked}
      editor={ed.draft ? { version: ed.version, saving: ed.saving, save: ed.save } : undefined}
      startOpen
    />
  );
}

export function FunilPreviewBlock({ block, ctx }: BlockProps<"funilPreview">) {
  const [live, setLive] = useState(false);
  if (live) return <FunilLive block={block} ctx={ctx} />;
  return <FunilPreviewView block={block} compact={ctx.compact} onAdjust={ctx.organizationId ? () => setLive(true) : undefined} />;
}

