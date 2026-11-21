import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { ClosureResult, ClosureRunLike } from "@/lib/agendaClosure";
import type { ConflictAction } from "@/lib/agendaConflict";

/**
 * ÚNICO ponto da página que chama `api.schedulingExceptions.*` (fechar e abrir recurso no dia, andamento do
 * fechamento em lotes e resolver conflito). As telas recebem funções e dados prontos.
 */
export interface ClosureScope {
  /** Ausente = a agenda inteira (exige `agenda:manage`; nada é realocado, tudo vira conflito). */
  resourceId?: string;
  fromLocalDate: string;
  toLocalDate?: string;
}

export interface CloseExtras {
  reasonCode?: "no_staff" | "maintenance" | "day_off" | "holiday" | "other";
  reason?: string;
}

export interface ClosureApi {
  previewClose: (scope: ClosureScope) => Promise<ClosureResult>;
  close: (scope: ClosureScope, extras: CloseExtras & { expectedAffected: number; acceptAffected: boolean }) => Promise<ClosureResult>;
  previewReopen: (scope: ClosureScope) => Promise<ClosureResult>;
  reopen: (scope: ClosureScope, extras: { expectedAffected: number; acceptAffected: boolean }) => Promise<ClosureResult>;
  resolve: (conflictId: string, action: ConflictAction) => Promise<null>;
}

const rid = (s: string) => s as Id<"schedResources">;

export function useClosureApi(organizationId: Id<"organizations">): ClosureApi {
  const preview = useMutation(api.schedulingExceptions.previewResourceClosure);
  const set = useMutation(api.schedulingExceptions.setResourceClosure);
  const remove = useMutation(api.schedulingExceptions.removeResourceClosure);
  const resolve = useMutation(api.schedulingExceptions.resolveConflict);
  return useMemo(() => {
    const base = (s: ClosureScope) => ({
      organizationId,
      ...(s.resourceId ? { resourceId: rid(s.resourceId) } : {}),
      fromLocalDate: s.fromLocalDate,
      ...(s.toLocalDate && s.toLocalDate !== s.fromLocalDate ? { toLocalDate: s.toLocalDate } : {}),
    });
    return {
      previewClose: (s) => preview(base(s)) as Promise<ClosureResult>,
      close: (s, e) =>
        set({
          ...base(s),
          ...(e.reasonCode ? { reasonCode: e.reasonCode } : {}),
          ...(e.reason ? { reason: e.reason } : {}),
          expectedAffected: e.expectedAffected,
          ...(e.acceptAffected ? { acceptAffected: true } : {}),
        }) as Promise<ClosureResult>,
      previewReopen: (s) => remove({ ...base(s), mode: "preview" }) as Promise<ClosureResult>,
      reopen: (s, e) =>
        remove({ ...base(s), mode: "commit", expectedAffected: e.expectedAffected, ...(e.acceptAffected ? { acceptAffected: true } : {}) }) as Promise<ClosureResult>,
      resolve: async (conflictId, action) => {
        const a =
          action.type === "resource"
            ? { type: "resource" as const, resourceIds: action.resourceIds.map(rid) }
            : action.type === "reschedule"
              ? { type: "reschedule" as const, startTime: action.startTime, ...(action.resourceIds ? { resourceIds: action.resourceIds.map(rid) } : {}) }
              : action;
        return await resolve({ organizationId, conflictId: conflictId as Id<"schedConflicts">, action: a });
      },
    };
  }, [organizationId, preview, set, remove, resolve]);
}

/** Andamento do fechamento em lotes; `null` = sem acesso ou não existe, `undefined` = carregando. */
export function useClosureRun(organizationId: Id<"organizations">, runId: string | null): ClosureRunLike | null | undefined {
  return useQuery(api.schedulingExceptions.getClosureRun, runId ? { organizationId, runId: runId as Id<"schedClosureRuns"> } : "skip");
}
