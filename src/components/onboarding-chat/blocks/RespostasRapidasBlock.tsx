import { useState } from "react";
import { MessageSquareText, Pencil, SlidersHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { plainModelText } from "@/lib/onboardingChat";
import { releaseQuickReply, removeQuickReply, setQuickReply } from "@/lib/onboardingDraftEdit";
import { buildBlock } from "../../../../convex/lib/onboardingBlocks";
import { DRAFT_LIMITS } from "../../../../convex/lib/onboardingDraft";
import { liveBlockContext, useDraftEditor } from "../useDraftEditor";
import { purposeOf } from "./ApprovableCard";
import { BlockCard } from "./BlockCard";
import { FlagNotice, FormActions, ReleaseControl, StaleNotice, Tag, useBaseVersion, type CardEditor } from "./draftParts";
import type { BlockOf, BlockProps } from "./types";

const COMPACT_ITEMS = 3;

export interface RespostasRapidasViewProps {
  block: BlockOf<"respostasRapidas">;
  compact?: boolean;
  editor?: CardEditor;
  /** `released[i]`: a resposta i foi liberada por uma pessoa (só com o rascunho vivo). */
  released?: readonly boolean[];
  onAdjust?: () => void;
}

export function RespostasRapidasView({ block, compact, editor, released, onAdjust }: RespostasRapidasViewProps) {
  const [editing, setEditing] = useState<number | null>(null);
  const items = Array.isArray(block.items) ? block.items : [];
  const shown = compact ? items.slice(0, COMPACT_ITEMS) : items;
  return (
    <BlockCard title="Respostas rápidas" icon={MessageSquareText} purpose={purposeOf(block)} note={compact ? undefined : block.note}>
      <ul className="mt-2 space-y-2" aria-label="Respostas rápidas">
        {shown.map((item, index) => {
          const isReleased = released?.[index] === true;
          const pending = item.suspicious && !isReleased;
          return (
          <li key={`${index}:${item.shortcut}`} className="rounded-field border border-border-subtle bg-surface-sunken p-2">
            {editing === index && editor ? (
              <QuickReplyForm
                shortcut={item.shortcut}
                text={item.text}
                editor={editor}
                index={index}
                onClose={() => setEditing(null)}
              />
            ) : (
              <>
                <p className="flex flex-wrap items-center gap-1.5 font-medium text-text-primary">
                  /{plainModelText(item.shortcut)}
                  {isReleased && <Tag tone="ok">Liberado por você</Tag>}
                </p>
                <p className={compact ? "line-clamp-2 text-text-secondary" : "whitespace-pre-wrap break-words text-text-secondary"}>
                  {plainModelText(item.text)}
                </p>
                {pending && !compact && (
                  <div className="mt-1.5">
                    <FlagNotice reason={item.suspicionReason} />
                  </div>
                )}
                {editor && !compact && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    {pending && (
                      <ReleaseControl
                        version={editor.version}
                        disabled={editor.saving}
                        onRelease={(reason, base) => editor.save(releaseQuickReply(index, reason), base)}
                      />
                    )}
                    <Button size="sm" variant="ghost" disabled={editor.saving} onClick={() => setEditing(index)}>
                      <Pencil className="size-3.5" aria-hidden="true" />
                      Editar
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={editor.saving}
                      aria-label={`Remover a resposta /${item.shortcut}`}
                      onClick={() => void editor.save(removeQuickReply(index), editor.version)}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                      Remover
                    </Button>
                  </div>
                )}
              </>
            )}
          </li>
          );
        })}
      </ul>
      {compact && items.length > COMPACT_ITEMS && (
        <p className="mt-1 text-caption text-text-muted">+ {items.length - COMPACT_ITEMS} na conversa</p>
      )}
      {!editor && onAdjust && !compact && (
        <Button size="sm" variant="secondary" className="mt-2" onClick={onAdjust}>
          <SlidersHorizontal className="size-3.5" aria-hidden="true" />
          Ajustar
        </Button>
      )}
    </BlockCard>
  );
}

function QuickReplyForm({
  shortcut,
  text,
  editor,
  index,
  onClose,
}: {
  shortcut: string;
  text: string;
  editor: CardEditor;
  index: number;
  onClose: () => void;
}) {
  const [nextShortcut, setShortcut] = useState(shortcut);
  const [nextText, setText] = useState(text);
  const { base, stale, reload } = useBaseVersion(editor.version, () => {
    setShortcut(shortcut);
    setText(text);
  });
  return (
    <div className="space-y-2">
      <Input label="Atalho" value={nextShortcut} maxLength={DRAFT_LIMITS.quickReplyShortcut} onChange={(e) => setShortcut(e.target.value)} />
      <Textarea label="Resposta" value={nextText} maxLength={DRAFT_LIMITS.quickReplyText} autoGrow onChange={(e) => setText(e.target.value)} />
      <StaleNotice stale={stale} onReload={reload} />
      <FormActions
        saving={editor.saving}
        saveDisabled={nextShortcut.trim().length === 0 || nextText.trim().length === 0 || stale}
        onCancel={onClose}
        onSave={() =>
          void editor
            .save(setQuickReply(index, { shortcut: nextShortcut.trim().replace(/^\//, ""), text: nextText.trim() }), base)
            .then((ok) => ok && onClose())
        }
      />
    </div>
  );
}

function RespostasLive({ block, ctx }: BlockProps<"respostasRapidas">) {
  const ed = useDraftEditor(ctx);
  const live = ed.draft
    ? (buildBlock({ kind: "respostasRapidas", note: block.note }, liveBlockContext(ed)) as BlockOf<"respostasRapidas"> | null)
    : null;
  // Sem respostas depois de remover a última: mostra o cartão vazio, não some.
  const view = live ?? (ed.draft ? { ...block, items: [] } : block);
  return (
    <RespostasRapidasView
      block={view}
      released={ed.draft?.quickReplies.map((q) => q.release?.at !== undefined)}
      compact={ctx.compact}
      editor={ed.draft ? { version: ed.version, saving: ed.saving, save: ed.save } : undefined}
    />
  );
}

export function RespostasRapidasBlock({ block, ctx }: BlockProps<"respostasRapidas">) {
  const [live, setLive] = useState(false);
  if (live) return <RespostasLive block={block} ctx={ctx} />;
  return <RespostasRapidasView block={block} compact={ctx.compact} onAdjust={ctx.organizationId ? () => setLive(true) : undefined} />;
}
