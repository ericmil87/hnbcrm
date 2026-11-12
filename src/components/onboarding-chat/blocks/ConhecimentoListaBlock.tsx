import { useState } from "react";
import { BookOpen, FileText, Globe, Image as ImageIcon, Mic, Pencil, Plus, Trash2, User, SlidersHorizontal } from "lucide-react";
import type { ComponentType } from "react";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Textarea";
import { plainModelText } from "@/lib/onboardingChat";
import { addKnowledge, releaseKnowledge, removeKnowledge, setKnowledgeText } from "@/lib/onboardingDraftEdit";
import { formatCount } from "@/lib/format";
import { buildBlock } from "../../../../convex/lib/onboardingBlocks";
import { DRAFT_LIMITS } from "../../../../convex/lib/onboardingDraft";
import { liveBlockContext, useDraftEditor } from "../useDraftEditor";
import { BlockCard } from "./BlockCard";
import { FlagNotice, FormActions, ReleaseControl, Tag, type CardEditor } from "./draftParts";
import type { BlockOf, BlockProps } from "./types";

type Item = BlockOf<"conhecimentoLista">["items"][number];

const ORIGIN: Record<string, { label: string; icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }> }> = {
  usuario: { label: "Você contou", icon: User },
  site: { label: "Do site", icon: Globe },
  pdf: { label: "Do PDF", icon: FileText },
  imagem: { label: "Da imagem", icon: ImageIcon },
  audio: { label: "Do áudio", icon: Mic },
  template: { label: "Modelo do segmento", icon: BookOpen },
};

/** Origem legível: o tipo (fixo) e, se houver, a referência (texto puro; link vira "[link removido]" e some). */
export function originText(item: Pick<Item, "originKind" | "originLabel">): string {
  const base = (ORIGIN[item.originKind] ?? ORIGIN.usuario).label;
  const label = plainModelText(item.originLabel ?? "");
  const sep = label.indexOf(": ");
  const detail = sep >= 0 ? label.slice(sep + 2).trim() : "";
  if (!detail || detail.includes("[link removido]")) return base;
  return `${base}: ${detail}`;
}

const COMPACT_ITEMS = 3;

export interface ConhecimentoListaViewProps {
  block: BlockOf<"conhecimentoLista">;
  compact?: boolean;
  editor?: CardEditor;
  onAdjust?: () => void;
}

export function ConhecimentoListaView({ block, compact, editor, onAdjust }: ConhecimentoListaViewProps) {
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const items = (Array.isArray(block.items) ? block.items : []).slice(0, DRAFT_LIMITS.knowledgeMax);
  const shown = compact ? items.slice(0, COMPACT_ITEMS) : items;
  const full = items.length >= DRAFT_LIMITS.knowledgeMax;

  return (
    <BlockCard title="O que o atendente sabe" icon={BookOpen} note={compact ? undefined : block.note}>
      <p className="text-caption text-text-secondary">
        <span className="tabular-nums">{formatCount(block.total)}</span> {block.total === 1 ? "fato" : "fatos"}
        {block.flagged > 0 && (
          <>
            {" "}
            · <span className="tabular-nums">{formatCount(block.flagged)}</span> marcado(s) para revisão
          </>
        )}
      </p>
      {items.length === 0 && <p className="mt-2 text-text-muted">Ainda não há nada aqui. Conte sobre o seu negócio ou envie um material.</p>}
      <ul className="mt-2 space-y-2" aria-label="Fatos do conhecimento">
        {shown.map((item) => {
          const origin = ORIGIN[item.originKind] ?? ORIGIN.usuario;
          const OriginIcon = origin.icon;
          const pending = item.suspicious && !item.released;
          return (
            <li key={item.index} className="rounded-field border border-border-subtle bg-surface-sunken p-2">
              {editing === item.index && editor ? (
                <KnowledgeForm
                  key={editor.version}
                  initial={item.text}
                  editor={editor}
                  onSave={(text) => setKnowledgeText(item.index, text)}
                  onClose={() => setEditing(null)}
                />
              ) : (
                <>
                  <p className="whitespace-pre-wrap break-words text-text-primary">{plainModelText(item.text)}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 text-caption text-text-muted">
                      <OriginIcon className="size-3.5" aria-hidden="true" />
                      {originText(item)}
                    </span>
                    {item.released && <Tag tone="ok">Liberado por você</Tag>}
                  </div>
                  {pending && !compact && <div className="mt-1.5"><FlagNotice reason={item.suspicionReason} /></div>}
                  {editor && !compact && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      {pending && (
                        <ReleaseControl
                          disabled={editor.saving}
                          onRelease={(reason) => editor.save(releaseKnowledge(item.index, reason), editor.version)}
                        />
                      )}
                      <Button size="sm" variant="ghost" disabled={editor.saving} onClick={() => setEditing(item.index)}>
                        <Pencil className="size-3.5" aria-hidden="true" />
                        Editar
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={editor.saving}
                        aria-label={`Remover o fato ${item.index + 1}`}
                        onClick={() => void editor.save(removeKnowledge(item.index), editor.version)}
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

      {editor && !compact && editing === "new" && (
        <div className="mt-2 rounded-field border border-border-subtle bg-surface-sunken p-2">
          <KnowledgeForm
            key={editor.version}
            initial=""
            editor={editor}
            saveLabel="Adicionar fato"
            onSave={(text) => addKnowledge(text)}
            onClose={() => setEditing(null)}
          />
        </div>
      )}
      {editor && !compact && editing !== "new" && (
        <Button size="sm" variant="secondary" className="mt-2" disabled={full} onClick={() => setEditing("new")}>
          <Plus className="size-3.5" aria-hidden="true" />
          Adicionar fato
        </Button>
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

function KnowledgeForm({
  initial,
  editor,
  onSave,
  onClose,
  saveLabel,
}: {
  initial: string;
  editor: CardEditor;
  onSave: (text: string) => ReturnType<typeof setKnowledgeText>;
  onClose: () => void;
  saveLabel?: string;
}) {
  const [text, setText] = useState(initial);
  const base = editor.version;
  return (
    <div className="space-y-2">
      <Textarea
        label="Fato"
        value={text}
        maxLength={DRAFT_LIMITS.knowledgeText}
        autoGrow
        onChange={(e) => setText(e.target.value)}
      />
      <FormActions
        saving={editor.saving}
        saveDisabled={text.trim().length === 0}
        saveLabel={saveLabel}
        onCancel={onClose}
        onSave={() => void editor.save(onSave(text.trim()), base).then((ok) => ok && onClose())}
      />
    </div>
  );
}

function ConhecimentoLive({ block, ctx }: BlockProps<"conhecimentoLista">) {
  const ed = useDraftEditor(ctx);
  const live = ed.draft
    ? (buildBlock({ kind: "conhecimentoLista", note: block.note }, liveBlockContext(ed)) as BlockOf<"conhecimentoLista"> | null)
    : null;
  return (
    <ConhecimentoListaView
      block={live ?? block}
      compact={ctx.compact}
      editor={ed.draft ? { version: ed.version, saving: ed.saving, save: ed.save } : undefined}
    />
  );
}

export function ConhecimentoListaBlock({ block, ctx }: BlockProps<"conhecimentoLista">) {
  const [live, setLive] = useState(false);
  if (live) return <ConhecimentoLive block={block} ctx={ctx} />;
  return <ConhecimentoListaView block={block} compact={ctx.compact} onAdjust={ctx.organizationId ? () => setLive(true) : undefined} />;
}
