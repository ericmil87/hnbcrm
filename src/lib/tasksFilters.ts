// Parte pura do estado de Tarefas que vive na URL (`useTasksUrlState`):
// `?view=&smart=&status=&assignee=&label=&project=`. Sem React.
import { enumParam, listParam, stringParam } from "./searchParamState";

/** `list` = lista agrupada; `status` = quadro por status (ou kanban de colunas dentro de um projeto). */
export const TASK_VIEW_VALUES = ["list", "status"] as const;
export type TaskUrlView = (typeof TASK_VIEW_VALUES)[number];

/** Ids dos pills de filtro rápido. */
export const SMART_FILTER_VALUES = [
  "all",
  "today",
  "overdue",
  "week",
  "unassigned",
  "reminders",
] as const;
export type SmartFilter = (typeof SMART_FILTER_VALUES)[number];

/** `""` = todos os status (padrão, fora da URL). */
export const TASK_STATUS_VALUES = ["", "pending", "in_progress", "completed", "cancelled"] as const;
export type TaskStatusFilter = (typeof TASK_STATUS_VALUES)[number];

export const viewCodec = enumParam(TASK_VIEW_VALUES, "list");
export const smartCodec = enumParam(SMART_FILTER_VALUES, "all");
export const statusCodec = enumParam(TASK_STATUS_VALUES, "");
export const assigneeCodec = stringParam;
export const projectCodec = stringParam;
/** Etiquetas: ids separados por vírgula. */
export const labelCodec = listParam;

/** Parte do estado de Tarefas guardada na URL. */
export interface TasksUrlState {
  view: TaskUrlView;
  smart: SmartFilter;
  status: TaskStatusFilter;
  assigneeId: string | null;
  labelIds: string[];
  projectId: string | null;
}

/** Estado → params serializados (`null` = fora da URL), prontos para `writeParams`. */
export function tasksUrlWrites(state: TasksUrlState): Record<string, string | null> {
  return {
    view: viewCodec.serialize(state.view),
    smart: smartCodec.serialize(state.smart),
    status: statusCodec.serialize(state.status),
    assignee: assigneeCodec.serialize(state.assigneeId),
    label: labelCodec.serialize(state.labelIds),
    project: projectCodec.serialize(state.projectId),
  };
}

export interface TaskIdLists {
  projectIds: readonly string[] | undefined;
  memberIds: readonly string[] | undefined;
  labelIds: readonly string[] | undefined;
}

export interface ResolvedTaskIds {
  projectId: string | null;
  assigneeId: string | null;
  labelIds: string[];
  /** Há id na URL cuja lista ainda carrega: a consulta de tarefas deve esperar. */
  pending: boolean;
}

/**
 * Ids da URL só valem se existirem na org atual (link colado de outra org, item
 * apagado ou id malformado). Enquanto a lista carrega o id fica de fora e
 * `pending` avisa para não consultar com filtro incompleto.
 */
export function resolveTaskIds(
  state: Pick<TasksUrlState, "projectId" | "assigneeId" | "labelIds">,
  lists: TaskIdLists
): ResolvedTaskIds {
  const pending =
    (state.projectId !== null && lists.projectIds === undefined) ||
    (state.assigneeId !== null && lists.memberIds === undefined) ||
    (state.labelIds.length > 0 && lists.labelIds === undefined);
  return {
    projectId:
      state.projectId !== null && lists.projectIds?.includes(state.projectId) ? state.projectId : null,
    assigneeId:
      state.assigneeId !== null && lists.memberIds?.includes(state.assigneeId) ? state.assigneeId : null,
    labelIds: lists.labelIds ? state.labelIds.filter((id) => lists.labelIds!.includes(id)) : [],
    pending,
  };
}
