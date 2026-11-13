import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import { ChevronDown } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { InboxChoiceList } from "@/components/inbox/InboxChoiceList";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Popover } from "@/components/ui/Popover";
import { Spinner } from "@/components/ui/Spinner";
import {
  buildStageGroups,
  type StageFilterGroup,
  type StageFilterStage,
} from "@/lib/inboxStageFilter";
import { VOCAB } from "@/lib/vocab";

/** Uma assinatura por funil (`getStages` é por funil); só monta quando precisa. */
function BoardStagesReporter({
  boardId,
  onStages,
}: {
  boardId: Id<"boards">;
  onStages: (boardId: string, stages: StageFilterStage[] | undefined) => void;
}) {
  const stages = useQuery(api.boards.getStages, { boardId }) as StageFilterStage[] | undefined;
  useEffect(() => {
    onStages(boardId, stages);
  }, [boardId, stages, onStages]);
  return null;
}

/**
 * Funis e etapas da org para o filtro. Assina SÓ com `enabled` (seletor aberto
 * ou `?stage=` na URL para mostrar o nome). `source` precisa ser renderizado.
 */
export function useStageGroups(organizationId: Id<"organizations">, enabled: boolean) {
  const boards = useQuery(api.boards.getBoards, enabled ? { organizationId } : "skip") as
    | { _id: Id<"boards">; name: string; archivedAt?: number | null }[]
    | undefined;
  const [stagesByBoard, setStagesByBoard] = useState<Record<string, StageFilterStage[] | undefined>>({});
  const [onStages] = useState(
    () => (boardId: string, stages: StageFilterStage[] | undefined) =>
      setStagesByBoard((prev) => (prev[boardId] === stages ? prev : { ...prev, [boardId]: stages }))
  );
  const activeBoards = (boards ?? []).filter((b) => !b.archivedAt);
  const groups = buildStageGroups(activeBoards, stagesByBoard);
  const loading = enabled && (boards === undefined || activeBoards.some((b) => stagesByBoard[b._id] === undefined));
  const source: ReactNode = enabled
    ? activeBoards.map((b) => <BoardStagesReporter key={`stages:${b._id}`} boardId={b._id} onStages={onStages} />)
    : null;
  return { groups, loading, source };
}

interface StageChoicesProps {
  groups: readonly StageFilterGroup[];
  loading: boolean;
  stageId: string | null;
  onChoose: (stageId: string | null) => void;
}

/** "Todas as etapas" no topo e as etapas agrupadas por funil. */
export function StageChoices({ groups, loading, stageId, onChoose }: StageChoicesProps) {
  return (
    <div className="space-y-2">
      <InboxChoiceList
        ariaLabel={`Todas as ${VOCAB.stage.many}`}
        choices={[{ id: "all", label: `Todas as ${VOCAB.stage.many}`, selected: !stageId }]}
        onChoose={() => onChoose(null)}
      />
      {loading && groups.length === 0 && (
        <div className="flex justify-center py-4">
          <Spinner size="sm" />
        </div>
      )}
      {groups.map((group) => (
        <div key={`board:${group.boardId}`}>
          <p className="px-3 pb-1 pt-2 text-caption font-semibold text-text-muted">{group.boardName}</p>
          <InboxChoiceList
            ariaLabel={`Etapas de ${group.boardName}`}
            choices={group.stages.map((s) => ({ id: s._id, label: s.name, selected: stageId === s._id }))}
            onChoose={(id) => onChoose(id)}
          />
        </div>
      ))}
    </div>
  );
}

interface StageFilterSheetProps {
  open: boolean;
  onClose: () => void;
  organizationId: Id<"organizations">;
  stageId: string | null;
  onChoose: (stageId: string | null) => void;
}

/** Celular: folha inferior aberta pelo chip "Etapa". */
export function StageFilterSheet({ open, onClose, organizationId, stageId, onChoose }: StageFilterSheetProps) {
  const { groups, loading, source } = useStageGroups(organizationId, open);
  return (
    <Modal open={open} onClose={onClose} title={`Filtrar por ${VOCAB.stage.one}`}>
      {source}
      <StageChoices
        groups={groups}
        loading={loading}
        stageId={stageId}
        onChoose={(id) => {
          onChoose(id);
          onClose();
        }}
      />
    </Modal>
  );
}

interface StageFilterButtonProps {
  organizationId: Id<"organizations">;
  stageId: string | null;
  /** Nome da etapa escolhida (já resolvido); ausente = "Etapa". */
  stageName?: string;
  onChoose: (stageId: string | null) => void;
}

/** Desktop: botão "Etapa" com popover das etapas por funil. */
export function StageFilterButton({ organizationId, stageId, stageName, onChoose }: StageFilterButtonProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const { groups, loading, source } = useStageGroups(organizationId, open);
  return (
    <>
      <Button
        ref={anchor}
        type="button"
        variant={stageId ? "secondary" : "ghost"}
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="max-w-[12rem]"
      >
        <span className="truncate">{stageId ? stageName || "Etapa" : "Etapa"}</span>
        <ChevronDown size={14} className="shrink-0" aria-hidden="true" />
      </Button>
      {source}
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchor={anchor}
        align="start"
        role="dialog"
        aria-label={`Filtrar por ${VOCAB.stage.one}`}
        className="w-64 max-h-80 overflow-y-auto p-2"
      >
        <StageChoices
          groups={groups}
          loading={loading}
          stageId={stageId}
          onChoose={(id) => {
            onChoose(id);
            setOpen(false);
          }}
        />
      </Popover>
    </>
  );
}
