import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useBlocker } from "react-router";
import { Bot, Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { TAB_ROUTES } from "@/lib/routes";
import type { Id } from "../../../../convex/_generated/dataModel";
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
      className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-2 rounded-card border border-border bg-surface-raised p-3 shadow-lg"
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

/** Avisa ao trocar de painel (ou fechar a aba) com alteração não salva. */
export function useUnsavedGuard(dirty: boolean) {
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm("Você tem alterações não salvas. Sair mesmo assim?")) blocker.proceed();
    else blocker.reset();
  }, [blocker]);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
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
      {children(ctx as ReadyProfileCtx)}
    </div>
  );
}

export interface PanelPart {
  dirty: boolean;
  errors: Record<string, string | undefined>;
  /** Patch com SÓ as chaves deste formulário. */
  patch: () => Record<string, unknown>;
  reset: () => void;
}

/** Salva só os formulários alterados, com erro agregado em toast e o aviso de saída. */
export function usePanelSave(parts: PanelPart[], save: (patch: AgentProfilePatch) => Promise<void>) {
  const [saving, setSaving] = useState(false);
  const dirty = parts.some((p) => p.dirty);
  useUnsavedGuard(dirty);

  const onSave = async () => {
    const changed = parts.filter((p) => p.dirty);
    const firstError = changed.flatMap((p) => Object.values(p.errors)).find(Boolean);
    if (firstError) {
      toast.error(firstError);
      return;
    }
    setSaving(true);
    try {
      await save(Object.assign({}, ...changed.map((p) => p.patch())) as AgentProfilePatch);
      changed.forEach((p) => p.reset());
      toast.success("Alterações salvas");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível salvar.");
    } finally {
      setSaving(false);
    }
  };

  return { dirty, saving, onSave, onDiscard: () => parts.forEach((p) => p.reset()) };
}
