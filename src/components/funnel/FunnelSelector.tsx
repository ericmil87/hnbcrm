import { useMemo } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Archive, ArchiveRestore, Check, ChevronDown, Plus, Settings2, Trash2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { cn } from "@/lib/utils";
import { VOCAB } from "@/lib/vocab";
import type { FunnelDialog } from "./FunnelDialogs";

export interface FunnelBoardSummary {
  _id: Id<"boards">;
  name: string;
  color: string;
  deletionStartedAt?: number;
}

export interface FunnelSelectorProps {
  boards: readonly FunnelBoardSummary[];
  archivedBoards: readonly FunnelBoardSummary[];
  /** Contador leve por funil (só leads ativos), já formatado ("12", "500+"). */
  leadCountByBoard: ReadonlyMap<string, string>;
  selectedBoardId: Id<"boards"> | null;
  onSelectBoard: (boardId: Id<"boards">) => void;
  onOpenDialog: (dialog: FunnelDialog) => void;
  canCreateLead: boolean;
}

function ColorDot({ color }: { color: string }) {
  // A cor do funil é dado escolhido pelo usuário.
  return <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}

/** Seletor de funil, funis arquivados, configurações do funil ativo e "Criar lead". */
export function FunnelSelector({
  boards,
  archivedBoards,
  leadCountByBoard,
  selectedBoardId,
  onSelectBoard,
  onOpenDialog,
  canCreateLead,
}: FunnelSelectorProps) {
  const unarchiveBoard = useMutation(api.boards.unarchiveBoard);
  const selectedBoard = boards.find((b) => b._id === selectedBoardId);

  const handleUnarchive = async (boardId: Id<"boards">) => {
    try {
      await unarchiveBoard({ boardId });
      toast.success("Funil restaurado");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível restaurar o funil.");
    }
  };

  const boardItems = useMemo<MenuItem[]>(
    () => [
      ...boards.map((board) => {
        const count = leadCountByBoard.get(board._id);
        return {
          id: board._id,
          label: count ? `${board.name} (${count})` : board.name,
          icon:
            board._id === selectedBoardId ? (
              <Check size={16} aria-hidden="true" className="shrink-0 text-brand-500" />
            ) : (
              <ColorDot color={board.color} />
            ),
          onSelect: () => onSelectBoard(board._id),
        };
      }),
      {
        id: "create-board",
        label: VOCAB.funnel.new,
        icon: <Plus size={16} aria-hidden="true" className="shrink-0" />,
        separatorBefore: true,
        onSelect: () => onOpenDialog({ kind: "createBoard" }),
      },
    ],
    [boards, leadCountByBoard, selectedBoardId, onSelectBoard, onOpenDialog]
  );

  const archivedItems: MenuItem[] = archivedBoards.flatMap<MenuItem>((board) =>
        board.deletionStartedAt
          ? [{ id: `${board._id}-deleting`, label: `${board.name} (excluindo…)`, disabled: true, onSelect: () => {} }]
          : [
              {
                id: `${board._id}-restore`,
                label: `Restaurar ${board.name}`,
                icon: <ArchiveRestore size={16} aria-hidden="true" className="shrink-0" />,
                onSelect: () => void handleUnarchive(board._id),
              },
              {
                id: `${board._id}-delete`,
                label: `Excluir ${board.name}`,
                icon: <Trash2 size={16} aria-hidden="true" className="shrink-0" />,
                danger: true,
                onSelect: () => onOpenDialog({ kind: "deleteBoard", board: { _id: board._id, name: board.name } }),
              },
            ]
  );

  const settingsItems: MenuItem[] = [
    { id: "edit", label: "Editar funil", onSelect: () => onOpenDialog({ kind: "editBoard" }) },
    { id: "stages", label: "Gerenciar etapas", onSelect: () => onOpenDialog({ kind: "manageStages" }) },
    {
      id: "archive",
      label: "Arquivar funil",
      icon: <Archive size={16} aria-hidden="true" className="shrink-0" />,
      onSelect: () => onOpenDialog({ kind: "archiveBoard" }),
    },
    {
      id: "delete",
      label: "Excluir funil",
      danger: true,
      onSelect: () => {
        if (selectedBoard) {
          onOpenDialog({ kind: "deleteBoard", board: { _id: selectedBoard._id, name: selectedBoard.name } });
        }
      },
    },
  ];

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Menu
        ariaLabel="Funis"
        align="start"
        items={boardItems}
        trigger={(props, { open }) => (
          <Button
            {...props}
            type="button"
            variant="secondary"
            className={cn("max-w-full min-w-0", open && "border-brand-500")}
          >
            {selectedBoard && <ColorDot color={selectedBoard.color} />}
            <span className="truncate">{selectedBoard?.name ?? VOCAB.funnel.nav}</span>
            <ChevronDown size={16} aria-hidden="true" className="shrink-0 text-text-muted" />
          </Button>
        )}
      />

      {archivedBoards.length > 0 && (
        <Menu
          ariaLabel="Funis arquivados"
          align="start"
          items={archivedItems}
          trigger={(props) => (
            <Button {...props} type="button" variant="secondary" aria-label="Funis arquivados">
              <Archive size={16} aria-hidden="true" />
              Arquivados
              <span className="text-xs font-normal tabular-nums text-text-muted">({archivedBoards.length})</span>
            </Button>
          )}
        />
      )}

      {selectedBoardId && (
        <Menu
          ariaLabel="Configurações do funil"
          items={settingsItems}
          trigger={(props) => (
            <Button {...props} type="button" variant="secondary" iconOnly aria-label="Configurações do funil">
              <Settings2 size={20} aria-hidden="true" />
            </Button>
          )}
        />
      )}

      {canCreateLead && (
        <Button
          type="button"
          onClick={() => onOpenDialog({ kind: "createLead" })}
          variant="primary"
          size="md"
          className="ml-auto whitespace-nowrap"
        >
          <Plus size={20} aria-hidden="true" />
          Criar lead
        </Button>
      )}
    </div>
  );
}
