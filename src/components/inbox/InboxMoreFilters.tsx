import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { Archive, Check, ChevronDown, ChevronRight } from "lucide-react";
import { InboxChoiceList } from "@/components/inbox/InboxChoiceList";
import { Popover } from "@/components/ui/Popover";
import type { InboxMoreFiltersModel } from "@/lib/inboxState";
import type { RelationFilter } from "@/lib/contactRelationList";
import { cn } from "@/lib/utils";

export interface InboxMoreFiltersActions {
  /** Chip da fileira que foi para o ▾ (mesmo efeito de tocar nele). */
  onChip: (id: string) => void;
  onType: (filter: RelationFilter) => void;
  onStage: () => void;
  onAi: () => void;
  onChannel: () => void;
  onLabel: (labelId: string) => void;
  onArchived: () => void;
}

interface InboxMoreFiltersPanelProps extends InboxMoreFiltersActions {
  model: InboxMoreFiltersModel;
  /** Fecha a camada antes de abrir outra escolha (etapa, IA, canal). */
  onDone: () => void;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <p className="px-3 pb-1 pt-3 text-caption font-semibold text-text-muted ">{children}</p>;
}

const ROW_CLASS =
  "flex w-full min-h-10 coarse:min-h-11 items-center gap-2 rounded-field px-3 text-left text-sm text-text-primary hover:bg-surface-overlay focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500";

function ActionRow({ label, value, active, onClick }: { label: string; value: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={ROW_CLASS}>
      <span className="shrink-0">{label}</span>
      <span className={cn("min-w-0 flex-1 truncate text-right", active ? "font-medium text-brand-500" : "text-text-muted")}>
        {value}
      </span>
      <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-text-muted" />
    </button>
  );
}

/** Conteúdo de "Mais filtros" (apresentacional; também usado nos testes). */
export function InboxMoreFiltersPanel({
  model,
  onDone,
  onChip,
  onType,
  onStage,
  onAi,
  onChannel,
  onLabel,
  onArchived,
}: InboxMoreFiltersPanelProps) {
  const then = (fn: () => void) => () => {
    onDone();
    fn();
  };
  return (
    <div className="p-2">
      <h2 className="px-3 pb-1 pt-2 text-base font-semibold text-text-primary">Mais filtros</h2>
      {model.filters.length > 0 && (
        <>
          <SectionTitle>Filtros</SectionTitle>
          <div role="group" aria-label="Filtros">
            {model.filters.map((chip) => (
              <button
                key={`chip:${chip.id}`}
                type="button"
                aria-pressed={chip.pressed}
                onClick={() => {
                  onDone();
                  onChip(chip.id);
                }}
                className={cn(ROW_CLASS, chip.pressed && "font-medium")}
              >
                <span className="min-w-0 flex-1 truncate">{chip.label}</span>
                {chip.count !== undefined && (
                  <span className="tabular-nums text-text-muted">
                    <span className="sr-only">, </span>
                    {chip.count > 999 ? "999+" : `${chip.count}${chip.countMore ? "+" : ""}`}
                  </span>
                )}
                {chip.pressed && <Check size={16} aria-hidden="true" className="shrink-0 text-brand-500" />}
              </button>
            ))}
          </div>
        </>
      )}
      <SectionTitle>Tipo de contato</SectionTitle>
      <InboxChoiceList
        ariaLabel="Tipo de contato"
        choices={model.types}
        onChoose={(id) => {
          onDone();
          onType(id as RelationFilter);
        }}
      />

      <div className="mt-2 border-t border-border pt-2">
      <ActionRow label="Etapa" value={model.stage.label} active={model.stage.active} onClick={then(onStage)} />
      {model.ai && <ActionRow label="IA" value={model.ai.label} active={model.ai.active} onClick={then(onAi)} />}
      {model.channel && (
        <ActionRow label="Canal e conta" value={model.channel.label} active={model.channel.active} onClick={then(onChannel)} />
      )}
      </div>

      {model.labels.length > 0 && (
        <>
          <SectionTitle>Etiquetas</SectionTitle>
          <div role="group" aria-label="Etiquetas">
            {model.labels.map((label) => (
              <button
                key={`label:${label.id}`}
                type="button"
                aria-pressed={label.selected}
                onClick={() => {
                  onDone();
                  onLabel(label.id);
                }}
                className={cn(ROW_CLASS, label.selected && "font-medium")}
              >
                <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
                <span className="min-w-0 flex-1 truncate">{label.name}</span>
                {label.selected && <Check size={16} aria-hidden="true" className="shrink-0 text-brand-500" />}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="mt-2 border-t border-border pt-2">
        <button type="button" onClick={then(onArchived)} className={ROW_CLASS}>
          <Archive size={16} aria-hidden="true" className="shrink-0 text-text-muted" />
          <span className="min-w-0 flex-1 truncate">{model.archived ? "Voltar para as ativas" : "Arquivadas"}</span>
        </button>
      </div>
    </div>
  );
}

interface InboxMoreFiltersButtonProps extends InboxMoreFiltersActions {
  model: InboxMoreFiltersModel;
  /** Celular: folha inferior em vez do popover ancorado. */
  sheet?: boolean;
}

/**
 * ▾ no fim da fileira de chips (estilo WhatsApp Web): abre "Mais filtros" com
 * Tipo (Equipe, Fornecedores, Parceiros, Robôs, Sem tipo), Etapa, IA, Canal e
 * conta, Etiquetas e Arquivadas. O filtro escolhido vira chip com ✕ na fileira.
 */
export function InboxMoreFiltersButton({ model, sheet = false, ...actions }: InboxMoreFiltersButtonProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const active = model.activeCount > 0;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={active ? `Mais filtros (${model.activeCount} ativo${model.activeCount === 1 ? "" : "s"})` : "Mais filtros"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "shrink-0 inline-flex h-8 w-8 coarse:h-11 coarse:w-11 items-center justify-center rounded-full transition-colors",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
          active || open
            ? "bg-brand-500/20 text-text-primary ring-1 ring-inset ring-brand-500/40"
            : "bg-surface-sunken text-text-secondary hover:text-text-primary"
        )}
      >
        <ChevronDown size={16} aria-hidden="true" className={cn("motion-safe:transition-transform", open && "rotate-180")} />
      </button>
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchor={anchor}
        align="end"
        sheet={sheet}
        role="dialog"
        aria-label="Mais filtros"
        className={sheet ? undefined : "w-72 max-h-[70vh] supports-[height:100dvh]:max-h-[70dvh] overflow-y-auto"}
      >
        <InboxMoreFiltersPanel model={model} onDone={() => setOpen(false)} {...actions} />
      </Popover>
    </>
  );
}
