import { useCallback, useMemo } from "react";
import { useSearchParamState } from "@/hooks/useSearchParamState";
import {
  assigneeCodec,
  labelCodec,
  projectCodec,
  smartCodec,
  statusCodec,
  tasksUrlWrites,
  viewCodec,
  type TasksUrlState,
} from "@/lib/tasksFilters";

/**
 * Estado de Tarefas que vive na URL (sempre `replace`; o padrão sai da URL):
 * `?view=&smart=&status=&assignee=&label=&project=`. `?task=` (detalhe, push)
 * continua na página. Escritas compostas (filtro salvo, trocar de projeto)
 * vão numa navegação só, porque dois `setSearchParams` seguidos não se compõem.
 */
export function useTasksUrlState() {
  const view = useSearchParamState("view", viewCodec);
  const smart = useSearchParamState("smart", smartCodec);
  const status = useSearchParamState("status", statusCodec);
  const assignee = useSearchParamState("assignee", assigneeCodec);
  const label = useSearchParamState("label", labelCodec);
  const project = useSearchParamState("project", projectCodec);

  const state = useMemo<TasksUrlState>(
    () => ({
      view: view.value,
      smart: smart.value,
      status: status.value,
      assigneeId: assignee.value,
      labelIds: label.value,
      projectId: project.value,
    }),
    [view.value, smart.value, status.value, assignee.value, label.value, project.value]
  );

  const { set: setSmart } = smart;
  const update = useCallback(
    (patch: Partial<TasksUrlState>) => {
      const next = { ...state, ...patch };
      const { smart: smartWrite, ...others } = tasksUrlWrites(next);
      // `smart` é só o portador da navegação; todos os params vão juntos.
      void smartWrite;
      setSmart(next.smart, { also: others });
    },
    [state, setSmart]
  );

  return { state, update };
}
