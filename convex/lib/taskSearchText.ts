// Fonte única do searchText de tarefas — usado por tasks.ts (escritas de task)
// e por taskProjects.ts/taskLabels.ts (rebuild quando label/projeto é renomeado
// ou excluído). Mantenha em sincronia com o search index `search_tasks`.
export function buildTaskSearchText(task: {
  title: string;
  description?: string;
  tags?: string[];
  labelNames?: string[];
  projectName?: string;
}): string {
  return [
    task.title,
    task.description,
    ...(task.tags || []),
    ...(task.labelNames || []),
    task.projectName,
  ].filter(Boolean).join(" ");
}
