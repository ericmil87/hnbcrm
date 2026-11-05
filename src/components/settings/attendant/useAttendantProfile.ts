import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { usePermissions } from "@/hooks/usePermissions";
import { isSameForm } from "@/lib/attendantConfig";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { Attendant } from "./types";

export type AgentProfilePatch = FunctionArgs<typeof api.aiSettings.updateAgentProfile>["patch"];

/**
 * Carrega o atendente e o estado da IA e salva patches PARCIAIS. Os textos
 * (jeito de atender, conhecimento) só são pedidos quando o painel precisa deles
 * (`needsTexts`) e só para quem tem `settings:manage`: sem permissão a query é
 * pulada de propósito e os campos ficam travados com aviso.
 */
export function useAttendantProfile(organizationId: Id<"organizations">, opts: { needsTexts?: boolean } = {}) {
  const status = useQuery(api.aiSettings.getAiStatus, { organizationId });
  const attendants = useQuery(api.aiSettings.listAttendants, { organizationId }) as Attendant[] | undefined;
  const { can } = usePermissions(organizationId);
  const canManage = can("settings", "manage");
  const attendant = attendants?.[0];
  const texts = useQuery(
    api.aiSettings.getAttendantTexts,
    opts.needsTexts && canManage && attendant ? { agentMemberId: attendant._id } : "skip",
  );
  const updateProfile = useMutation(api.aiSettings.updateAgentProfile);

  const save = async (patch: AgentProfilePatch, extra?: { autopilotRiskAck?: boolean }) => {
    if (!attendant) throw new Error("Ligue o Atendente IA primeiro.");
    await updateProfile({ agentMemberId: attendant._id, patch, ...extra });
  };

  return {
    loading: status === undefined || attendants === undefined,
    ready: Boolean(status?.active && attendant),
    status,
    attendant,
    profile: attendant?.agentProfile,
    texts: texts ?? null,
    canManage,
    save,
  };
}

/**
 * Rascunho de um formulário: enquanto não há edição vale o valor salvo (que
 * muda sozinho quando o servidor atualiza); `dirty` só com diferença real.
 */
export function useFormDraft<T>(saved: T) {
  const [draft, setDraft] = useState<T | null>(null);
  const value = draft ?? saved;
  return {
    value,
    setValue: (next: T) => setDraft(next),
    dirty: draft !== null && !isSameForm(draft, saved),
    reset: () => setDraft(null),
  };
}
