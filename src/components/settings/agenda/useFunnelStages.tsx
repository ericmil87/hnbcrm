import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { StageOption } from "@/lib/agendaConfigForms";

function BoardStages({ boardId, onStages }: { boardId: Id<"boards">; onStages: (id: string, s: StageOption[] | undefined) => void }) {
  const stages = useQuery(api.boards.getStages, { boardId }) as StageOption[] | undefined;
  useEffect(() => onStages(boardId, stages), [boardId, stages, onStages]);
  return null;
}

/** Funis ativos com as etapas (inclui `isClosedLost`). `source` precisa ser renderizado (uma assinatura por funil). */
export function useFunnelStages(organizationId: Id<"organizations">) {
  const boards = useQuery(api.boards.getBoards, { organizationId }) as { _id: Id<"boards">; name: string; archivedAt?: number | null }[] | undefined;
  const [byBoard, setByBoard] = useState<Record<string, StageOption[] | undefined>>({});
  const [onStages] = useState(() => (id: string, s: StageOption[] | undefined) => setByBoard((p) => (p[id] === s ? p : { ...p, [id]: s })));
  const active = (boards ?? []).filter((b) => !b.archivedAt);
  const loading = boards === undefined || active.some((b) => byBoard[b._id] === undefined);
  const groups = active.map((b) => ({ _id: b._id as string, name: b.name, stages: byBoard[b._id] ?? [] }));
  const source: ReactNode = active.map((b) => <BoardStages key={`stages:${b._id}`} boardId={b._id} onStages={onStages} />);
  return { groups, loading, source };
}
