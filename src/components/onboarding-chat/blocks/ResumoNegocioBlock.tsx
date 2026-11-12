import { useState } from "react";
import { Building2, MapPin, SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { plainModelText } from "@/lib/onboardingChat";
import { releaseBusiness, setBusiness } from "@/lib/onboardingDraftEdit";
import { buildBlock } from "../../../../convex/lib/onboardingBlocks";
import { DRAFT_LIMITS } from "../../../../convex/lib/onboardingDraft";
import { liveBlockContext, useDraftEditor } from "../useDraftEditor";
import { BlockCard } from "./BlockCard";
import { FlagNotice, FormActions, ReleaseControl, StaleNotice, useBaseVersion, type CardEditor } from "./draftParts";
import type { BlockOf, BlockProps } from "./types";

export interface ResumoNegocioViewProps {
  block: BlockOf<"resumoNegocio">;
  compact?: boolean;
  editor?: CardEditor;
  onAdjust?: () => void;
  startOpen?: boolean;
}

/** `resumoNegocio`: nome, segmento, descrição e cidade do rascunho, com "Ajustar" e liberação de trecho marcado. */
export function ResumoNegocioView({ block, compact, editor, onAdjust, startOpen = false }: ResumoNegocioViewProps) {
  const [open, setOpen] = useState(startOpen);
  const name = plainModelText(block.name) || "Seu negócio";
  const description = plainModelText(block.description);
  const city = plainModelText(block.city);
  return (
    <BlockCard title="Resumo do negócio" icon={Building2} note={compact ? undefined : block.note}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 break-words font-semibold">{name}</p>
        {block.segmentLabel && <Badge variant="brand">{plainModelText(block.segmentLabel)}</Badge>}
      </div>
      {description && (
        <p className={compact ? "mt-1 line-clamp-3 text-text-secondary" : "mt-1 whitespace-pre-wrap break-words text-text-secondary"}>
          {description}
        </p>
      )}
      {city && (
        <p className="mt-1 inline-flex items-center gap-1 text-caption text-text-muted">
          <MapPin className="size-3.5" aria-hidden="true" />
          {city}
        </p>
      )}
      {block.suspicious && (
        <div className="mt-2 space-y-1.5">
          <p className="rounded-field bg-semantic-warning/10 px-2 py-1.5 text-caption text-text-primary">
            Este resumo tem um trecho marcado para revisão antes de entrar na operação.
          </p>
          {!compact && <FlagNotice reason={block.suspicionReason} />}
          {editor && !compact && (
            <ReleaseControl
              version={editor.version}
              disabled={editor.saving}
              onRelease={(reason, base) => editor.save(releaseBusiness(reason), base)}
            />
          )}
        </div>
      )}
      {open && editor ? (
        <BusinessForm block={block} editor={editor} onClose={() => setOpen(false)} />
      ) : (
        (editor || onAdjust) &&
        !compact && (
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => (editor ? setOpen(true) : onAdjust?.())}>
            <SlidersHorizontal className="size-3.5" aria-hidden="true" />
            Ajustar
          </Button>
        )
      )}
    </BlockCard>
  );
}

function BusinessForm({ block, editor, onClose }: { block: BlockOf<"resumoNegocio">; editor: CardEditor; onClose: () => void }) {
  const [name, setName] = useState(block.name);
  const [description, setDescription] = useState(block.description);
  const [city, setCity] = useState(block.city ?? "");
  const { base, stale, reload } = useBaseVersion(editor.version, () => {
    setName(block.name);
    setDescription(block.description);
    setCity(block.city ?? "");
  });
  return (
    <div className="mt-2 space-y-2 rounded-field border border-border-subtle bg-surface-sunken p-2">
      <Input label="Nome do negócio" value={name} maxLength={DRAFT_LIMITS.businessName} onChange={(e) => setName(e.target.value)} />
      <Textarea
        label="O que o negócio faz"
        value={description}
        maxLength={DRAFT_LIMITS.businessDescription}
        autoGrow
        onChange={(e) => setDescription(e.target.value)}
      />
      <Input label="Cidade" value={city} maxLength={DRAFT_LIMITS.businessCity} onChange={(e) => setCity(e.target.value)} />
      <StaleNotice stale={stale} onReload={reload} />
      <FormActions
        saving={editor.saving}
        saveDisabled={name.trim() === "" || description.trim() === "" || stale}
        onCancel={onClose}
        onSave={() =>
          void editor
            .save(setBusiness({ name: name.trim(), description: description.trim(), city }), base)
            .then((ok) => ok && onClose())
        }
      />
    </div>
  );
}

function ResumoLive({ block, ctx }: BlockProps<"resumoNegocio">) {
  const ed = useDraftEditor(ctx);
  const live = ed.draft
    ? (buildBlock({ kind: "resumoNegocio", note: block.note }, liveBlockContext(ed)) as BlockOf<"resumoNegocio"> | null)
    : null;
  return (
    <ResumoNegocioView
      block={live ?? block}
      compact={ctx.compact}
      editor={ed.draft ? { version: ed.version, saving: ed.saving, save: ed.save } : undefined}
      startOpen
    />
  );
}

export function ResumoNegocioBlock({ block, ctx }: BlockProps<"resumoNegocio">) {
  const [live, setLive] = useState(false);
  if (live) return <ResumoLive block={block} ctx={ctx} />;
  return <ResumoNegocioView block={block} compact={ctx.compact} onAdjust={ctx.organizationId ? () => setLive(true) : undefined} />;
}
