import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useBlocker } from "react-router";
import { Bot, Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { buildPanelPatch, snapshotDirtyParts, partsToResetAfterSave, type PanelPart as PanelPartData } from "@/lib/attendantConfig";
import { TAB_ROUTES } from "@/lib/routes";
import type { Id } from "../../../../convex/_generated/dataModel";
import { MultiAttendantNotice } from "./MultiAttendantNotice";
import { useAttendantProfile, type AgentProfilePatch } from "./useAttendantProfile";

type ProfileCtx = ReturnType<typeof useAttendantProfile>;
export type ReadyProfileCtx = ProfileCtx & {
  attendant: NonNullable<ProfileCtx["attendant"]>;
  profile: NonNullable<ProfileCtx["profile"]>;
};

/** Barra "Salvar alterações": só aparece com alteração pendente. */
export function SaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  if (!dirty) return null;
  return (
    <div
      role="region"
      aria-label="Alterações pendentes"
      className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 -mx-1 md:bottom-0 flex flex-wrap items-center justify-between gap-2 rounded-card border border-border bg-surface-raised p-3 shadow-lg"
    >
      <p className="text-sm text-text-secondary">Você tem alterações não salvas.</p>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onDiscard} disabled={saving}>
          Descartar
        </Button>
        <Button onClick={onSave} loading={saving}>
          Salvar alterações
        </Button>
      </div>
    </div>
  );
}

/** Avisa ao trocar de painel (ou fechar a aba) com alteração não salva; devolve o diálogo a renderizar. */
export function useUnsavedGuard(dirty: boolean) {
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
  return (
    <ConfirmDialog
      open={blocker.state === "blocked"}
      onClose={() => blocker.reset?.()}
      onConfirm={() => blocker.proceed?.()}
      title="Sair sem salvar?"
      description="Você tem alterações não salvas neste painel. Se sair agora, elas serão perdidas."
      confirmLabel="Sair sem salvar"
      cancelLabel="Continuar editando"
      variant="danger"
    />
  );
}

/**
 * Casca dos painéis do atendente: carrega, trata "IA desligada / sem atendente"
 * com um atalho para a visão geral e avisa quando falta permissão.
 */
export function AttendantPanelFrame({
  organizationId,
  needsTexts,
  children,
}: {
  organizationId: Id<"organizations">;
  needsTexts?: boolean;
  children: (ctx: ReadyProfileCtx) => ReactNode;
}) {
  const ctx = useAttendantProfile(organizationId, { needsTexts });
  if (ctx.loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }
  if (!ctx.ready || !ctx.attendant || !ctx.profile) {
    return (
      <EmptyState
        icon={Bot}
        title="Ligue o Atendente IA primeiro"
        description="Estas configurações aparecem depois que a IA está ativa e o atendente foi criado."
        action={{ label: "Ir para a visão geral", href: `${TAB_ROUTES.settings}?secao=ai` }}
      />
    );
  }
  return (
    <div className="space-y-4">
      {!ctx.canManage && (
        <p className="flex items-center gap-2 rounded-lg border border-border bg-surface-sunken p-3 text-sm text-text-secondary">
          <Lock size={14} className="shrink-0" aria-hidden="true" />
          Só quem gerencia as configurações pode alterar estes campos.
        </p>
      )}
      <MultiAttendantNotice count={ctx.activeAttendantCount} name={ctx.attendant.name} />
      {children(ctx as ReadyProfileCtx)}
    </div>
  );
}

export interface PanelPart extends PanelPartData {
  reset: () => void;
}

/** Salva só os formulários alterados, com o primeiro erro em toast e o aviso de saída. */
export function usePanelSave(parts: PanelPart[], save: (patch: AgentProfilePatch) => Promise<void>) {
  const [saving, setSaving] = useState(false);
  const dirty = parts.some((p) => p.dirty);
  const guardDialog = useUnsavedGuard(dirty);
  // Estado mais recente dos formulários: o `await` do salvar pode terminar depois de novas edições.
  const latest = useRef(parts);
  useEffect(() => {
    latest.current = parts;
  });

  const onSave = async () => {
    const built = buildPanelPatch(parts);
    if (!built.ok) {
      toast.error(built.message);
      return;
    }
    const submitted = snapshotDirtyParts(parts);
    setSaving(true);
    try {
      await save(built.patch as AgentProfilePatch);
      // Só zera o rascunho que ainda é o que foi enviado; edição feita durante o salvar permanece.
      partsToResetAfterSave(submitted, latest.current).forEach((i) => latest.current[i].reset());
      toast.success("Alterações salvas");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível salvar.");
    } finally {
      setSaving(false);
    }
  };

  return { dirty, saving, onSave, onDiscard: () => parts.forEach((p) => p.reset()), guardDialog };
}
