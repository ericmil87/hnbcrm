import { useCallback, useMemo, useRef } from "react";
import { useLocation, useSearchParams } from "react-router";
import { useSearchParamState } from "@/hooks/useSearchParamState";
import { writeParams } from "@/lib/searchParamState";
import {
  assigneeCodec,
  labelCodec,
  projectCodec,
  smartCodec,
  statusCodec,
  DEFAULT_TASKS_URL_STATE,
  tasksUrlWrites,
  viewCodec,
  type TasksUrlState,
} from "@/lib/tasksFilters";

const NOSCROLL = { preventScrollReset: true } as const;

/**
 * Estado de Tarefas que vive na URL (sempre `replace`; o padrão sai da URL):
 * `?view=&smart=&status=&assignee=&label=&project=`. `?task=` (detalhe, push)
 * continua na página. Escritas compostas (filtro salvo, trocar de projeto)
 * vão numa navegação só, porque dois `setSearchParams` seguidos não se compõem.
 * `update` escreve apenas as chaves do `patch`, sobre a URL viva.
 */
export function useTasksUrlState() {
  const view = useSearchParamState("view", viewCodec, NOSCROLL);
  const smart = useSearchParamState("smart", smartCodec, NOSCROLL);
  const status = useSearchParamState("status", statusCodec, NOSCROLL);
  const assignee = useSearchParamState("assignee", assigneeCodec, NOSCROLL);
  const label = useSearchParamState("label", labelCodec, NOSCROLL);
  const project = useSearchParamState("project", projectCodec, NOSCROLL);

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

  const [, setSearchParams] = useSearchParams();
  // `replace` sem `state` apagaria a marca de entrada nossa (ex.: ?task=): relê o state vivo.
  const locationState = useLocation().state;
  const stateRef = useRef<unknown>(locationState);
  stateRef.current = locationState;
  const update = useCallback(
    (patch: Partial<TasksUrlState>) => {
      // Só as chaves do `patch` entram na escrita; as demais seguem como estão na
      // URL (`prev` é a URL do último render do router, não uma leitura ao vivo).
      const writes = tasksUrlWrites({ ...DEFAULT_TASKS_URL_STATE, ...patch });
      const keys: Record<keyof TasksUrlState, string> = {
        view: "view",
        smart: "smart",
        status: "status",
        assigneeId: "assignee",
        labelIds: "label",
        projectId: "project",
      };
      const picked: Record<string, string | null> = {};
      for (const field of Object.keys(patch) as (keyof TasksUrlState)[]) {
        picked[keys[field]] = writes[keys[field]];
      }
      setSearchParams((prev) => writeParams(prev, picked), {
        replace: true,
        preventScrollReset: true,
        ...(stateRef.current != null ? { state: stateRef.current } : {}),
      });
    },
    [setSearchParams]
  );

  return { state, update };
}
