import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Archive, Pencil, Plus, RotateCcw, Scissors } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { SlideOver } from "@/components/ui/SlideOver";
import { Spinner } from "@/components/ui/Spinner";
import { useAgendaConfig } from "@/hooks/useAgendaConfig";
import {
  durationLabel, hasErrors, isEmptyPatch, newServiceForm, serviceCreateArgs, serviceErrors, serviceFormFrom, servicePatchArgs, withVariantKeys, type ServiceForm,
} from "@/lib/agendaConfigForms";
import { runWithFutureAccept, serviceArchiveAccept } from "@/lib/agendaFutureAccept";
import { mutationErrorMessage } from "@/lib/errors";
import { VOCAB } from "@/lib/vocab";
import type { SettingsPanelProps } from "../registry";
import { ServiceFormFields } from "./ServiceFormFields";
import { useFutureAsk } from "./useFutureAsk";

type Service = Doc<"schedServices">;

/** Painel "Serviços": lista, editor em folha, arquivar/reativar. */
export function AgendaServicesPanel({ organizationId }: SettingsPanelProps) {
  const { config } = useAgendaConfig(organizationId);
  const upsert = useMutation(api.schedulingConfig.upsertService);
  const archive = useMutation(api.schedulingConfig.archiveService);
  const reactivate = useMutation(api.schedulingConfig.reactivateService);
  const { ask, dialog } = useFutureAsk();

  const [editing, setEditing] = useState<{ id: Id<"schedServices"> | null; initial: ServiceForm } | null>(null);
  const [draft, setDraft] = useState<ServiceForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  if (config === undefined) return <div className="flex justify-center py-12"><Spinner size="lg" /></div>;
  if (config === null || !config.enabled) {
    return <EmptyState icon={Scissors} title={VOCAB.scheduling.config.noAccess.title} description={VOCAB.scheduling.config.noAccess.hint} />;
  }

  const all = config.services;
  const visible = all.filter((s) => showArchived || s.active);
  const archivedCount = all.filter((s) => !s.active).length;
  const errors = draft && editing ? serviceErrors(draft, all, editing.id ?? undefined) : {};

  const open = (id: Id<"schedServices"> | null, form: ServiceForm) => {
    setEditing({ id, initial: form });
    setDraft(form);
    setShowErrors(false);
  };
  const close = () => {
    setEditing(null);
    setDraft(null);
    setConfirmDiscard(false);
  };
  const draftDirty = !!draft && !!editing && JSON.stringify(draft) !== JSON.stringify(editing.initial);
  /** Fechar com alteração pendente pergunta antes de descartar. */
  const requestClose = () => (draftDirty ? setConfirmDiscard(true) : close());

  const save = async () => {
    if (!draft || !editing) return;
    if (hasErrors(errors)) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      const form = { ...draft, variants: withVariantKeys(draft.variants) };
      if (editing.id === null) await upsert({ organizationId, ...serviceCreateArgs(form) });
      else {
        const patch = servicePatchArgs(form, editing.initial);
        if (isEmptyPatch(patch)) {
          close();
          return;
        }
        await upsert({ organizationId, serviceId: editing.id, ...patch });
      }
      toast.success(editing.id === null ? "Serviço criado" : "Alterações salvas");
      close();
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível salvar."));
    } finally {
      setSaving(false);
    }
  };

  const archiveOne = async (s: Service) => {
    try {
      const outcome = await runWithFutureAccept(
        (acceptFuture) => archive({ organizationId, serviceId: s._id, ...(acceptFuture ? { acceptFuture: true } : {}) }),
        (r) => serviceArchiveAccept(s.name, r),
        ask
      );
      if (outcome.done) toast.success("Serviço arquivado");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível arquivar."));
    }
  };
  const reactivateOne = async (s: Service) => {
    try {
      await reactivate({ organizationId, serviceId: s._id });
      toast.success("Serviço reativado");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível reativar."));
    }
  };

  const newButton = (
    <Button size="sm" onClick={() => open(null, newServiceForm())}>
      <Plus size={14} aria-hidden="true" /> Novo serviço
    </Button>
  );

  return (
    <>
      <SectionCard title={VOCAB.scheduling.settings.services.label} description={VOCAB.scheduling.settings.services.description} actions={all.length > 0 ? newButton : undefined}>
        {all.length === 0 ? (
          <EmptyState icon={Scissors} size="sm" title={VOCAB.scheduling.empty.services.title} description={VOCAB.scheduling.empty.services.hint} action={{ label: "Novo serviço", onClick: () => open(null, newServiceForm()) }} />
        ) : (
          <>
            <ul className="divide-y divide-border">
              {visible.map((s) => (
                <li key={s._id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-primary">
                      {s.name}
                      {!s.active && <Badge variant="warning">Arquivado</Badge>}
                      {s.aiBookable === false && <Badge>Sem IA</Badge>}
                      {s.publicBookable === true && <Badge variant="brand">Link público</Badge>}
                    </p>
                    <p className="mt-0.5 text-sm text-text-muted tabular-nums">
                      {durationLabel(s.durationMin)}
                      {s.variants && s.variants.length > 0 ? ` · ${s.variants.map((v) => `${v.name} ${durationLabel(v.durationMin)}`).join(", ")}` : ""}
                      {" · "}
                      {s.requirements.map((r) => r.role).join(" + ")}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    {s.active ? (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => open(s._id, serviceFormFrom(s))} aria-label={`Editar ${s.name}`}>
                          <Pencil size={14} aria-hidden="true" /> Editar
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void archiveOne(s)} aria-label={`Arquivar ${s.name}`}>
                          <Archive size={14} aria-hidden="true" /> Arquivar
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => void reactivateOne(s)} aria-label={`Reativar ${s.name}`}>
                        <RotateCcw size={14} aria-hidden="true" /> Reativar
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {archivedCount > 0 && (
              <Button size="sm" variant="ghost" className="mt-2" onClick={() => setShowArchived((v) => !v)}>
                {showArchived ? "Ocultar arquivados" : `Mostrar arquivados (${archivedCount})`}
              </Button>
            )}
          </>
        )}
      </SectionCard>

      <SlideOver open={editing !== null} onClose={requestClose} title={editing?.id ? "Editar serviço" : "Novo serviço"}>
        {draft && editing && (
          <div className="space-y-5 p-4">
            <ServiceFormFields
              value={draft}
              onChange={setDraft}
              errors={showErrors ? errors : {}}
              disabled={saving}
              resources={config.resources.map((r) => ({ _id: r._id, name: r.name, kind: r.kind, active: r.active }))}
            />
            <div className="flex gap-2 pb-safe">
              <Button variant="secondary" className="flex-1" onClick={requestClose} disabled={saving}>Cancelar</Button>
              <Button className="flex-1" loading={saving} onClick={() => void save()}>Salvar</Button>
            </div>
          </div>
        )}
      </SlideOver>
      <ConfirmDialog open={confirmDiscard} onClose={() => setConfirmDiscard(false)} onConfirm={close} title="Descartar alterações?" description="O que você mudou aqui ainda não foi salvo." confirmLabel="Descartar" cancelLabel="Continuar editando" variant="danger" />
      {dialog}
    </>
  );
}
