import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Archive, DoorOpen, Pencil, Plus, RotateCcw, Users } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { SlideOver } from "@/components/ui/SlideOver";
import { Spinner } from "@/components/ui/Spinner";
import { useAgendaConfig } from "@/hooks/useAgendaConfig";
import {
  hasErrors, newResourceForm, resourceCreateArgs, resourceErrors, resourceFormFrom, resourcePatchArgs, type ResourceForm, type ResourceKind,
} from "@/lib/agendaConfigForms";
import { resourceArchiveAccept, resourceEditAccept, runWithFutureAccept } from "@/lib/agendaFutureAccept";
import { weekSummary } from "@/lib/agendaWeek";
import { mutationErrorMessage } from "@/lib/errors";
import { VOCAB } from "@/lib/vocab";
import type { SettingsPanelProps } from "../registry";
import { ResourceFormFields, type MemberOption } from "./ResourceFormFields";
import { useFutureAsk } from "./useFutureAsk";

type Resource = Doc<"schedResources">;
const NEW_TITLE: Record<ResourceKind, string> = { person: "Novo profissional", room: "Nova sala", equipment: "Novo equipamento" };

interface TeamMemberRow {
  _id: Id<"teamMembers">;
  name: string;
  type: string;
  removed?: boolean;
}

/** Painel "Salas e profissionais": lista, editor em folha, arquivar/reativar e aceite quando afeta horários marcados. */
export function AgendaResourcesPanel({ organizationId }: SettingsPanelProps) {
  const { config } = useAgendaConfig(organizationId);
  const members = useQuery(api.teamMembers.getTeamMembers, { organizationId }) as TeamMemberRow[] | undefined;
  const upsert = useMutation(api.schedulingConfig.upsertResource);
  const archive = useMutation(api.schedulingConfig.archiveResource);
  const reactivate = useMutation(api.schedulingConfig.reactivateResource);
  const { ask, dialog } = useFutureAsk();

  const [editing, setEditing] = useState<{ id: Id<"schedResources"> | null; initial: ResourceForm } | null>(null);
  const [draft, setDraft] = useState<ResourceForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  if (config === undefined) return <div className="flex justify-center py-12"><Spinner size="lg" /></div>;
  if (config === null || !config.enabled) {
    return <EmptyState icon={DoorOpen} title="Sem acesso à Agenda" description="Peça a quem administra a conta a permissão para configurar a Agenda." />;
  }

  const all = config.resources;
  const visible = all.filter((r) => showArchived || r.active);
  const archivedCount = all.filter((r) => !r.active).length;
  const linkedElsewhere = (selfId: string | null) =>
    new Set(all.filter((r) => r.active && r._id !== selfId && r.teamMemberId).map((r) => r.teamMemberId as string));
  const memberOptions = (selfId: string | null, current: string): MemberOption[] => {
    const taken = linkedElsewhere(selfId);
    return (members ?? [])
      .filter((m) => m.type === "human" && !m.removed && (!taken.has(m._id) || m._id === current))
      .map((m) => ({ value: m._id, label: m.name }));
  };

  const open = (id: Id<"schedResources"> | null, form: ResourceForm) => {
    setEditing({ id, initial: form });
    setDraft(form);
    setShowErrors(false);
  };
  const close = () => {
    setEditing(null);
    setDraft(null);
  };

  const errors = draft && editing ? resourceErrors(draft, all, editing.id ?? undefined) : {};

  const save = async () => {
    if (!draft || !editing) return;
    if (hasErrors(errors)) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      const name = draft.name.trim();
      if (editing.id === null) {
        await upsert({ organizationId, ...resourceCreateArgs(draft) });
        toast.success("Criado");
      } else {
        const patch = resourcePatchArgs(draft, editing.initial);
        const resourceId = editing.id;
        const outcome = await runWithFutureAccept(
          (acceptFuture) => upsert({ organizationId, resourceId, ...patch, ...(acceptFuture ? { acceptFuture: true } : {}) }),
          (r) => resourceEditAccept(name, r),
          ask
        );
        if (!outcome.done) return;
        toast.success("Alterações salvas");
      }
      close();
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível salvar."));
    } finally {
      setSaving(false);
    }
  };

  const archiveOne = async (r: Resource) => {
    try {
      const outcome = await runWithFutureAccept(
        (acceptFuture) => archive({ organizationId, resourceId: r._id, ...(acceptFuture ? { acceptFuture: true } : {}) }),
        (res) => resourceArchiveAccept(r.name, res),
        ask
      );
      if (outcome.done) toast.success("Arquivado");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível arquivar."));
    }
  };
  const reactivateOne = async (r: Resource) => {
    try {
      await reactivate({ organizationId, resourceId: r._id });
      toast.success("Reativado");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível reativar."));
    }
  };

  const addButtons = (
    <>
      {(["person", "room", "equipment"] as ResourceKind[]).map((k) => (
        <Button key={`add:${k}`} size="sm" variant={k === "room" ? "primary" : "secondary"} onClick={() => open(null, newResourceForm(k))}>
          <Plus size={14} aria-hidden="true" /> {VOCAB.scheduling.resource[k].title}
        </Button>
      ))}
    </>
  );

  return (
    <>
      <SectionCard title={VOCAB.scheduling.settings.resources.label} description={VOCAB.scheduling.settings.resources.description} actions={all.length > 0 ? addButtons : undefined}>
        {all.length === 0 ? (
          <EmptyState icon={DoorOpen} size="sm" title={VOCAB.scheduling.empty.resources.title} description={VOCAB.scheduling.empty.resources.hint}>
            <div className="mt-3 flex flex-wrap justify-center gap-2">{addButtons}</div>
          </EmptyState>
        ) : (
          <>
            <ul className="divide-y divide-border">
              {visible.map((r) => (
                <li key={r._id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-primary">
                      {r.name}
                      <Badge>{VOCAB.scheduling.resource[r.kind].title}</Badge>
                      {r.kind !== "person" && r.capacity > 1 && (
                        <Badge variant="brand"><Users size={12} className="mr-1" aria-hidden="true" />{r.capacity} pessoas ao mesmo tempo</Badge>
                      )}
                      {!r.active && <Badge variant="warning">Arquivado</Badge>}
                    </p>
                    <p className="mt-0.5 text-sm text-text-muted">{weekSummary(resourceFormFrom(r).week)}</p>
                  </div>
                  <div className="flex gap-1">
                    {r.active ? (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => open(r._id, resourceFormFrom(r))} aria-label={`Editar ${r.name}`}>
                          <Pencil size={14} aria-hidden="true" /> Editar
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void archiveOne(r)} aria-label={`Arquivar ${r.name}`}>
                          <Archive size={14} aria-hidden="true" /> Arquivar
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => void reactivateOne(r)} aria-label={`Reativar ${r.name}`}>
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

      <SlideOver open={editing !== null} onClose={close} title={editing?.id ? "Editar" : draft ? NEW_TITLE[draft.kind] : "Novo"}>
        {draft && editing && (
          <div className="space-y-5 p-4">
            <ResourceFormFields
              value={draft}
              onChange={setDraft}
              errors={showErrors ? errors : {}}
              disabled={saving}
              kindLocked={editing.id !== null}
              memberOptions={memberOptions(editing.id, draft.teamMemberId)}
            />
            <div className="flex gap-2 pb-safe">
              <Button variant="secondary" className="flex-1" onClick={close} disabled={saving}>Cancelar</Button>
              <Button className="flex-1" loading={saving} onClick={() => void save()}>Salvar</Button>
            </div>
          </div>
        )}
      </SlideOver>
      {dialog}
    </>
  );
}
