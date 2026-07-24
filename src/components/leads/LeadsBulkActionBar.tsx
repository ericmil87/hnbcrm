import { useEffect, useRef, useState } from "react";
import { ArrowRightLeft, Archive, Plus, Tag, UserPlus, UserX, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Avatar } from "@/components/ui/Avatar";

// Barra flutuante de ações em massa para a view de lista de leads. Aparece
// quando `count > 0` (o pai decide se renderiza). Puramente apresentacional:
// nenhuma query/mutation aqui, apenas callbacks.

export interface LeadsBulkActionBarProps {
  count: number;
  stages: { _id: string; name: string; color?: string }[];
  teamMembers: { _id: string; name: string; type?: "human" | "ai" }[];
  onMove: (stageId: string) => void;
  onAssign: (memberId: string | null) => void;
  onAddTag: (tag: string) => void;
  onArchive: () => void;
  archiveLabel: string;
  onClear: () => void;
}

type PopoverKey = "move" | "assign" | "tag";

function actionButtonClass(active: boolean) {
  return cn(
    "inline-flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary",
    active && "bg-surface-raised text-text-primary"
  );
}

export function LeadsBulkActionBar({
  count,
  stages,
  teamMembers,
  onMove,
  onAssign,
  onAddTag,
  onArchive,
  archiveLabel,
  onClear,
}: LeadsBulkActionBarProps) {
  const [openPopover, setOpenPopover] = useState<PopoverKey | null>(null);
  const [tagValue, setTagValue] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openPopover) return;
    const handlePointer = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenPopover(null);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenPopover(null);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [openPopover]);

  useEffect(() => {
    if (openPopover !== "tag") setTagValue("");
  }, [openPopover]);

  const togglePopover = (key: PopoverKey) => {
    setOpenPopover((current) => (current === key ? null : key));
  };

  const handleAddTag = () => {
    const trimmed = tagValue.trim();
    if (!trimmed) return;
    onAddTag(trimmed);
    setTagValue("");
    setOpenPopover(null);
  };

  return (
    <div
      ref={rootRef}
      className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] md:bottom-4 md:pb-0"
    >
      <div className="flex w-full max-w-2xl flex-wrap items-center gap-1.5 rounded-2xl border border-border bg-surface-overlay p-2 shadow-elevated">
        <span className="whitespace-nowrap px-2 text-sm font-medium tabular-nums text-text-primary">
          {count} selecionado{count === 1 ? "" : "s"}
        </span>

        <div className="hidden h-6 w-px bg-border md:block" />

        {/* Mover */}
        <div className="relative">
          <button
            type="button"
            onClick={() => togglePopover("move")}
            className={actionButtonClass(openPopover === "move")}
          >
            <ArrowRightLeft size={15} />
            Mover
          </button>
          {openPopover === "move" && (
            <div className="absolute bottom-full left-0 z-50 mb-2 max-h-64 w-56 overflow-y-auto rounded-xl border border-border bg-surface-overlay py-1 shadow-elevated">
              {stages.length === 0 ? (
                <p className="px-3 py-2 text-xs text-text-muted">Nenhuma etapa disponível</p>
              ) : (
                stages.map((stage) => (
                  <button
                    key={stage._id}
                    type="button"
                    onClick={() => {
                      onMove(stage._id);
                      setOpenPopover(null);
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-text-primary transition-colors hover:bg-surface-raised"
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: stage.color || "#71717A" }}
                    />
                    <span className="truncate">{stage.name}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* Atribuir */}
        <div className="relative">
          <button
            type="button"
            onClick={() => togglePopover("assign")}
            className={actionButtonClass(openPopover === "assign")}
          >
            <UserPlus size={15} />
            Atribuir
          </button>
          {openPopover === "assign" && (
            <div className="absolute bottom-full left-0 z-50 mb-2 max-h-64 w-56 overflow-y-auto rounded-xl border border-border bg-surface-overlay py-1 shadow-elevated">
              <button
                type="button"
                onClick={() => {
                  onAssign(null);
                  setOpenPopover(null);
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-text-muted transition-colors hover:bg-surface-raised"
              >
                <UserX size={14} />
                Remover responsável
              </button>
              {teamMembers.length > 0 && <div className="my-1 border-t border-border" />}
              {teamMembers.map((member) => (
                <button
                  key={member._id}
                  type="button"
                  onClick={() => {
                    onAssign(member._id);
                    setOpenPopover(null);
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-text-primary transition-colors hover:bg-surface-raised"
                >
                  <Avatar name={member.name} type={member.type} size="sm" />
                  <span className="truncate">{member.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Etiquetar */}
        <div className="relative">
          <button
            type="button"
            onClick={() => togglePopover("tag")}
            className={actionButtonClass(openPopover === "tag")}
          >
            <Tag size={15} />
            Etiquetar
          </button>
          {openPopover === "tag" && (
            <div className="absolute bottom-full left-0 z-50 mb-2 w-64 rounded-xl border border-border bg-surface-overlay p-2.5 shadow-elevated">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleAddTag();
                }}
                className="flex items-center gap-1.5"
              >
                <input
                  autoFocus
                  value={tagValue}
                  onChange={(e) => setTagValue(e.target.value)}
                  placeholder="Nova etiqueta"
                  className="h-9 flex-1 rounded-lg border border-border-strong bg-surface-sunken px-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
                  style={{ fontSize: "16px" }}
                />
                <Button type="submit" variant="primary" size="sm" disabled={!tagValue.trim()} aria-label="Adicionar etiqueta">
                  <Plus size={14} />
                </Button>
              </form>
            </div>
          )}
        </div>

        <div className="hidden h-6 w-px bg-border md:block" />

        {/* Arquivar / Desarquivar */}
        <button type="button" onClick={onArchive} className={actionButtonClass(false)}>
          <Archive size={15} />
          {archiveLabel}
        </button>

        <div className="ml-auto flex items-center">
          <button
            type="button"
            onClick={onClear}
            aria-label="Cancelar seleção"
            className="flex h-11 w-11 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-raised hover:text-text-primary"
          >
            <X size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
