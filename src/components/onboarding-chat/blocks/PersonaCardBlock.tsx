import { useState } from "react";
import { Bot, Languages, SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { plainModelText } from "@/lib/onboardingChat";
import { releaseGreeting, setPersona } from "@/lib/onboardingDraftEdit";
import { languageDisplayName } from "@/lib/translationRules";
import { VOCAB } from "@/lib/vocab";
import { buildBlock } from "../../../../convex/lib/onboardingBlocks";
import { liveBlockContext, useDraftEditor } from "../useDraftEditor";
import { BlockCard } from "./BlockCard";
import { FlagNotice, FormActions, ReleaseControl, StaleNotice, useBaseVersion, type CardEditor } from "./draftParts";
import type { BlockOf, BlockProps } from "./types";

const TONES = [
  { value: "formal", label: "Formal" },
  { value: "amigavel", label: "Amigável" },
  { value: "descontraido", label: "Descontraído" },
];
const ADDRESS = [
  { value: "voce", label: "Você" },
  { value: "senhor", label: "Senhor(a)" },
];

export interface PersonaCardViewProps {
  block: BlockOf<"personaCard">;
  compact?: boolean;
  editor?: CardEditor;
  /** Sem `editor`: pede para carregar o rascunho vivo e abrir o ajuste. */
  onAdjust?: () => void;
  startOpen?: boolean;
}

/** Cartão do jeito de atender: nome, tom, tratamento, idiomas e saudação, com "Ajustar" (campos fechados). */
export function PersonaCardView({ block, compact, editor, onAdjust, startOpen = false }: PersonaCardViewProps) {
  const [open, setOpen] = useState(startOpen);
  const name = plainModelText(block.attendantName) || VOCAB.attendant.name;
  const languages = (Array.isArray(block.languages) ? block.languages : []).map((l) => languageDisplayName(l)).filter(Boolean);
  const greeting = block.greeting;
  const canAdjust = Boolean(editor || onAdjust);

  return (
    <BlockCard title="Jeito de atender" icon={Bot} note={compact ? undefined : block.note}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 break-words font-semibold">{name}</p>
        <Badge variant="brand">{plainModelText(block.toneLabel)}</Badge>
        <Badge>{block.addressAs === "senhor" ? "Trata por senhor(a)" : "Trata por você"}</Badge>
      </div>
      {!compact && languages.length > 0 && (
        <p className="mt-1 inline-flex items-center gap-1 text-caption text-text-muted">
          <Languages className="size-3.5" aria-hidden="true" />
          {languages.join(", ")}
        </p>
      )}
      <p className="mt-1 text-caption text-text-muted">Sempre se apresenta como IA.</p>
      {greeting && !compact && (
        <div className="mt-2 space-y-1.5">
          <p className="whitespace-pre-wrap break-words rounded-field bg-surface-sunken px-2 py-1.5 text-text-secondary">
            {plainModelText(greeting.text)}
          </p>
          {greeting.suspicious && (
            <>
              <FlagNotice />
              {editor && (
                <ReleaseControl
                  version={editor.version}
                  disabled={editor.saving}
                  onRelease={(reason, base) => editor.save(releaseGreeting(reason), base)}
                />
              )}
            </>
          )}
        </div>
      )}

      {open && editor ? (
        <PersonaForm block={block} editor={editor} onClose={() => setOpen(false)} />
      ) : (
        canAdjust && (
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => (editor ? setOpen(true) : onAdjust?.())}>
            <SlidersHorizontal className="size-3.5" aria-hidden="true" />
            Ajustar
          </Button>
        )
      )}
    </BlockCard>
  );
}

function PersonaForm({ block, editor, onClose }: { block: BlockOf<"personaCard">; editor: CardEditor; onClose: () => void }) {
  const [attendantName, setName] = useState(block.attendantName);
  const [tone, setTone] = useState<string>(block.tone);
  const [addressAs, setAddress] = useState<string>(block.addressAs);
  const { base, stale, reload } = useBaseVersion(editor.version, () => {
    setName(block.attendantName);
    setTone(block.tone);
    setAddress(block.addressAs);
  });
  return (
    <div className="mt-2 space-y-3 rounded-field border border-border-subtle bg-surface-sunken p-2">
      <Input label="Nome do atendente" value={attendantName} maxLength={40} onChange={(e) => setName(e.target.value)} />
      <div className="space-y-1">
        <p className="text-[13px] font-medium text-text-secondary">Tom</p>
        <SegmentedControl ariaLabel="Tom do atendente" value={tone} onValueChange={setTone} options={TONES} size="sm" />
      </div>
      <div className="space-y-1">
        <p className="text-[13px] font-medium text-text-secondary">Como trata o cliente</p>
        <SegmentedControl ariaLabel="Tratamento" value={addressAs} onValueChange={setAddress} options={ADDRESS} size="sm" />
      </div>
      <StaleNotice stale={stale} onReload={reload} />
      <FormActions
        saving={editor.saving}
        saveDisabled={attendantName.trim().length === 0 || stale}
        onCancel={onClose}
        onSave={() =>
          void editor
            .save(
              setPersona({
                attendantName: attendantName.trim(),
                tone: tone as "formal" | "amigavel" | "descontraido",
                addressAs: addressAs as "voce" | "senhor",
              }),
              base
            )
            .then((ok) => ok && onClose())
        }
      />
    </div>
  );
}

/** Versão com o rascunho vivo: mostra o que está gravado agora e permite editar. */
function PersonaLive({ block, ctx }: BlockProps<"personaCard">) {
  const ed = useDraftEditor(ctx);
  const live = ed.draft ? (buildBlock({ kind: "personaCard", note: block.note }, liveBlockContext(ed)) as BlockOf<"personaCard"> | null) : null;
  return (
    <PersonaCardView
      block={live ?? block}
      compact={ctx.compact}
      editor={ed.draft ? { version: ed.version, saving: ed.saving, save: ed.save } : undefined}
      startOpen
    />
  );
}

export function PersonaCardBlock({ block, ctx }: BlockProps<"personaCard">) {
  const [live, setLive] = useState(false);
  if (live) return <PersonaLive block={block} ctx={ctx} />;
  return <PersonaCardView block={block} compact={ctx.compact} onAdjust={ctx.organizationId ? () => setLive(true) : undefined} />;
}
