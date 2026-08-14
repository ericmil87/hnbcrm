import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { ChevronRight, Plus } from "lucide-react";

interface SubtasksSectionProps {
  taskId: Id<"tasks">;
  organizationId: Id<"organizations">;
  /** Projeto da task-pai — subtarefas novas herdam o mesmo projeto. */
  projectId?: Id<"taskProjects"> | null;
  /** Abre a subtarefa no lugar da task atual (navegação interna do slide-over). */
  onOpenSubtask: (subtaskId: Id<"tasks">) => void;
  className?: string;
}

export function SubtasksSection({
  taskId,
  organizationId,
  projectId,
  onOpenSubtask,
  className,
}: SubtasksSectionProps) {
  const [newTitle, setNewTitle] = useState("");
  const [adding, setAdding] = useState(false);

  const data = useQuery(api.tasks.getSubtasks, { taskId });
  const createTask = useMutation(api.tasks.createTask);
  const completeTask = useMutation(api.tasks.completeTask);
  const updateTask = useMutation(api.tasks.updateTask);

  const subtasks = data?.subtasks ?? [];
  const total = data?.total ?? 0;
  const completed = data?.completed ?? 0;

  const handleToggle = async (subtask: { _id: Id<"tasks">; status: string }) => {
    try {
      if (subtask.status === "completed") {
        await updateTask({ taskId: subtask._id, status: "pending" });
      } else {
        await completeTask({ taskId: subtask._id });
      }
    } catch {
      toast.error("Falha ao atualizar subtarefa");
    }
  };

  const handleAdd = async () => {
    const title = newTitle.trim();
    if (!title || adding) return;
    setAdding(true);
    try {
      await createTask({
        organizationId,
        title,
        type: "task",
        priority: "medium",
        activityType: "todo",
        parentTaskId: taskId,
        projectId: projectId ?? undefined,
      });
      setNewTitle("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao criar subtarefa");
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className={cn("px-4 py-4", className)}>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-text-primary">Subtarefas</h4>
        {total > 0 && (
          <span className="text-xs text-text-muted tabular-nums">
            {completed}/{total}
          </span>
        )}
      </div>

      {total > 0 && (
        <div className="w-full bg-surface-sunken rounded-full h-1.5 mb-3">
          <div
            className="h-1.5 rounded-full bg-brand-500 transition-all duration-300"
            style={{ width: `${(completed / total) * 100}%` }}
          />
        </div>
      )}

      {data === undefined ? (
        <div className="flex justify-center py-3">
          <Spinner size="sm" />
        </div>
      ) : (
        subtasks.length > 0 && (
          <div className="space-y-1 mb-2">
            {subtasks.map((subtask: any) => {
              const isDone = subtask.status === "completed" || subtask.status === "cancelled";
              return (
                <div
                  key={subtask._id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-sunken transition-colors group"
                >
                  <button
                    type="button"
                    onClick={() => handleToggle(subtask)}
                    className={cn(
                      "shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors",
                      isDone
                        ? "border-semantic-success bg-semantic-success"
                        : "border-border-strong hover:border-brand-500"
                    )}
                    aria-label={isDone ? "Reabrir subtarefa" : "Concluir subtarefa"}
                  >
                    {isDone && (
                      <svg width="10" height="8" viewBox="0 0 10 8" fill="none" className="text-white">
                        <path
                          d="M1 4L3.5 6.5L9 1"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => onOpenSubtask(subtask._id)}
                    className={cn(
                      "flex-1 min-w-0 text-left text-sm truncate",
                      isDone ? "text-text-muted line-through" : "text-text-primary"
                    )}
                  >
                    {subtask.title}
                  </button>

                  {subtask.assignee && (
                    <Avatar
                      name={subtask.assignee.name}
                      type={subtask.assignee.type}
                      size="sm"
                      imageUrl={subtask.assignee.avatarUrl ?? null}
                      className="shrink-0"
                    />
                  )}

                  <ChevronRight
                    size={14}
                    className="text-text-muted shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  />
                </div>
              );
            })}
          </div>
        )
      )}

      <div className="flex gap-2">
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder="Adicionar subtarefa..."
          className="flex-1 px-3 py-1.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 placeholder:text-text-muted"
          style={{ fontSize: "16px" }}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={handleAdd}
          disabled={!newTitle.trim() || adding}
          aria-label="Adicionar subtarefa"
        >
          <Plus size={16} />
        </Button>
      </div>
    </div>
  );
}
