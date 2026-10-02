import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import {
  Building2,
  FlaskConical,
  LayoutDashboard,
  Layers,
  Megaphone,
  Pencil,
  Plus,
  Trash2,
  ClipboardPaste,
  Inbox,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Doc, Id } from "../../../convex/_generated/dataModel";
import { usePermissions } from "@/hooks/usePermissions";
import { useOrgModules, type OrgModules } from "@/hooks/useOrgModules";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Checkbox } from "@/components/ui/Checkbox";
import { Avatar } from "@/components/ui/Avatar";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import { assignableMembers } from "@/lib/teamMembers";
import { DEPARTMENT_ICONS, DepartmentIcon } from "@/components/central/departmentIcons";
import { parseAdSpendCsv, type AdSpendPlatform } from "@/components/central/adSpendCsv";
import {
  formatBRL,
  formatFullDate,
  lastNDays,
  localDateString,
} from "@/components/central/centralFormat";

type ModuleKey = keyof Omit<OrgModules, "demoMode">;

const MODULES: Array<{ key: ModuleKey; label: string; description: string; icon: React.ElementType }> = [
  {
    key: "units",
    label: "Unidades",
    description: "Cadastre hotéis ou filiais e marque cada conversa e lead com a unidade.",
    icon: Building2,
  },
  {
    key: "departments",
    label: "Setores",
    description: "Filas de atendimento (Reservas, Financeiro, Compras…) com transferência entre setores na Caixa de Entrada.",
    icon: Layers,
  },
  {
    key: "attribution",
    label: "Origem e investimento",
    description: "Registre de qual anúncio veio cada lead e quanto foi investido em mídia, para calcular CAC e ROAS.",
    icon: Megaphone,
  },
  {
    key: "central",
    label: "Painel da Central",
    description: "Painel em tempo real com KPIs por hotel, campanha e setor (menu \"Central\").",
    icon: LayoutDashboard,
  },
];

const COLOR_PRESETS = [
  "#F97316", "#3B82F6", "#22C55E", "#A855F7", "#EC4899", "#14B8A6",
  "#EAB308", "#EF4444", "#6366F1", "#84CC16", "#06B6D4", "#F43F5E",
];

const selectClass =
  "w-full min-h-[44px] bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-base md:text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20";
const textareaClass =
  "w-full bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-base md:text-sm placeholder:text-text-muted focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20";
const labelClass = "block text-[13px] font-medium text-text-secondary mb-1.5";

export function CentralSection({ organizationId }: { organizationId: Id<"organizations"> }) {
  const { can } = usePermissions(organizationId);
  const canManage = can("settings", "manage");
  const { modules, isLoading } = useOrgModules(organizationId);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton variant="card" className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {modules.demoMode && (
        <div className="flex items-start gap-2.5 rounded-card border border-semantic-info/30 bg-semantic-info/5 p-3 text-sm text-text-secondary">
          <FlaskConical size={16} className="mt-0.5 shrink-0 text-semantic-info" aria-hidden="true" />
          <p>Organização de demonstração — nenhuma mensagem sai para o WhatsApp.</p>
        </div>
      )}
      <ModulesCard organizationId={organizationId} modules={modules} canManage={canManage} />
      {modules.units && <UnitsCard organizationId={organizationId} canManage={canManage} />}
      {modules.departments && (
        <DepartmentsCard organizationId={organizationId} canManage={canManage} showUnits={modules.units} />
      )}
      {modules.attribution && (
        <AdSpendCard organizationId={organizationId} canManage={canManage} showUnits={modules.units} />
      )}
    </div>
  );
}

// --- Módulos ---------------------------------------------------------------

function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
        "before:absolute before:-inset-2.5 before:content-['']",
        checked ? "bg-brand-500" : "bg-surface-overlay border border-border-strong",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
      )}
    >
      <span
        className={cn(
          "pointer-events-none h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-5" : "translate-x-1"
        )}
      />
    </button>
  );
}

function ModulesCard({
  organizationId,
  modules,
  canManage,
}: {
  organizationId: Id<"organizations">;
  modules: OrgModules;
  canManage: boolean;
}) {
  const setOrgModules = useMutation(api.orgModules.setOrgModules);
  const [busy, setBusy] = useState<ModuleKey | null>(null);

  const toggle = async (key: ModuleKey) => {
    const next = !modules[key];
    setBusy(key);
    try {
      await setOrgModules({ organizationId, modules: { [key]: next } });
      toast.success(`${MODULES.find((m) => m.key === key)?.label} ${next ? "ligado" : "desligado"}`);
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível alterar o módulo"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <h3 className="text-lg font-semibold text-text-primary">Central de atendimento</h3>
      <p className="mt-1 mb-4 text-sm text-text-secondary">
        Módulos opcionais para quem atende várias unidades num só WhatsApp. Desligados, nada muda no seu CRM.
      </p>
      <ul className="divide-y divide-border-subtle">
        {MODULES.map((m) => {
          const Icon = m.icon;
          return (
            <li key={m.key} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-500/10 text-brand-500">
                <Icon size={18} aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text-primary">{m.label}</p>
                <p className="mt-0.5 text-xs text-text-muted">{m.description}</p>
              </div>
              <div className="pt-1.5">
                <Switch
                  checked={modules[m.key]}
                  onChange={() => toggle(m.key)}
                  label={m.label}
                  disabled={!canManage || busy !== null}
                />
              </div>
            </li>
          );
        })}
      </ul>
      {!canManage && (
        <p className="mt-3 text-xs text-text-muted">Só administradores podem ligar ou desligar módulos.</p>
      )}
    </Card>
  );
}

function ColorField({ value, onChange, label }: { value: string; onChange: (c: string) => void; label: string }) {
  return (
    <div>
      <span className={labelClass}>{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        {COLOR_PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            aria-label={`Cor ${c}`}
            aria-pressed={value.toLowerCase() === c.toLowerCase()}
            className={cn(
              "h-8 w-8 rounded-full border-2 transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
              value.toLowerCase() === c.toLowerCase() ? "border-text-primary scale-110" : "border-transparent"
            )}
            style={{ background: c }}
          />
        ))}
        <label className="relative h-8 w-8 cursor-pointer overflow-hidden rounded-full border border-border-strong" title="Outra cor">
          <span className="sr-only">Outra cor</span>
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="absolute -inset-2 h-12 w-12 cursor-pointer"
          />
        </label>
      </div>
    </div>
  );
}

// --- Unidades --------------------------------------------------------------

const UNIT_STATUS: Record<Doc<"units">["status"], { label: string; variant: "success" | "warning" | "default" }> = {
  active: { label: "Ativa", variant: "success" },
  onboarding: { label: "Em implantação", variant: "warning" },
  inactive: { label: "Inativa", variant: "default" },
};

function UnitsCard({ organizationId, canManage }: { organizationId: Id<"organizations">; canManage: boolean }) {
  const units = useQuery(api.units.listUnits, { organizationId });
  const deleteUnit = useMutation(api.units.deleteUnit);
  const [editing, setEditing] = useState<Doc<"units"> | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Doc<"units"> | null>(null);

  const onDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deleteUnit({ unitId: confirmDelete._id });
      toast.success("Unidade excluída");
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível excluir a unidade"));
    }
    setConfirmDelete(null);
  };

  return (
    <Card>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-text-primary">Unidades</h3>
          <p className="mt-1 text-sm text-text-secondary">Hotéis e pousadas atendidos pela Central.</p>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus size={16} aria-hidden="true" /> Nova unidade
          </Button>
        )}
      </div>

      {units === undefined ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : units.length === 0 ? (
        <p className="py-4 text-sm text-text-muted">Nenhuma unidade cadastrada ainda.</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {units.map((u) => {
            const status = UNIT_STATUS[u.status];
            const place = [u.kind, [u.city, u.state].filter(Boolean).join("/")].filter(Boolean).join(" · ");
            return (
              <li key={u._id} className={cn("flex items-center gap-3 py-3", u.status === "inactive" && "opacity-60")}>
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: u.color }} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-primary">
                    <span className="truncate">{u.name}</span>
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </p>
                  <p className="mt-0.5 truncate text-xs text-text-muted">
                    {[place, u.roomsCount ? `${u.roomsCount} quartos` : "", u.whatsappLabel].filter(Boolean).join(" · ") ||
                      "Sem detalhes"}
                  </p>
                </div>
                {canManage && (
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => setEditing(u)}
                      className="flex h-11 w-11 items-center justify-center rounded-full text-text-muted hover:bg-surface-overlay hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      aria-label={`Editar ${u.name}`}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(u)}
                      className="flex h-11 w-11 items-center justify-center rounded-full text-text-muted hover:bg-semantic-error/10 hover:text-semantic-error focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      aria-label={`Excluir ${u.name}`}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {editing && (
        <UnitModal
          organizationId={organizationId}
          unit={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={onDelete}
        title="Excluir unidade?"
        description={`"${confirmDelete?.name ?? ""}" será removida. Unidades com leads ou conversas não podem ser excluídas — marque-as como inativas.`}
        confirmLabel="Excluir"
        variant="danger"
      />
    </Card>
  );
}

function UnitModal({
  organizationId,
  unit,
  onClose,
}: {
  organizationId: Id<"organizations">;
  unit: Doc<"units"> | null;
  onClose: () => void;
}) {
  const createUnit = useMutation(api.units.createUnit);
  const updateUnit = useMutation(api.units.updateUnit);
  const [form, setForm] = useState(() => ({
    name: unit?.name ?? "",
    shortName: unit?.shortName ?? "",
    kind: unit?.kind ?? "",
    city: unit?.city ?? "",
    state: unit?.state ?? "",
    whatsappLabel: unit?.whatsappLabel ?? "",
    roomsCount: unit?.roomsCount !== undefined ? String(unit.roomsCount) : "",
    bookingUrl: unit?.bookingUrl ?? "",
    status: unit?.status ?? ("active" as Doc<"units">["status"]),
    color: unit?.color ?? COLOR_PRESETS[0],
    description: unit?.description ?? "",
  }));
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("Informe o nome da unidade");
      return;
    }
    const rooms = form.roomsCount.trim() ? Number(form.roomsCount) : undefined;
    if (rooms !== undefined && (!Number.isInteger(rooms) || rooms < 0)) {
      toast.error("Número de quartos inválido");
      return;
    }
    const fields = {
      name: form.name.trim(),
      shortName: form.shortName.trim(),
      kind: form.kind.trim(),
      city: form.city.trim(),
      state: form.state.trim().toUpperCase(),
      whatsappLabel: form.whatsappLabel.trim(),
      bookingUrl: form.bookingUrl.trim(),
      description: form.description.trim(),
      status: form.status,
      color: form.color,
      ...(rooms !== undefined ? { roomsCount: rooms } : {}),
    };
    setSaving(true);
    try {
      if (unit) {
        await updateUnit({ unitId: unit._id, ...fields });
        toast.success("Unidade atualizada");
      } else {
        await createUnit({ organizationId, ...fields });
        toast.success("Unidade criada");
      }
      onClose();
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível salvar a unidade"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={unit ? "Editar unidade" : "Nova unidade"}>
      <form onSubmit={submit} className="space-y-4">
        <Input id="unit-name" label="Nome" value={form.name} onChange={(e) => set("name", e.target.value)} required autoFocus />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input id="unit-short" label="Nome curto" placeholder="Ex.: Vale" value={form.shortName} onChange={(e) => set("shortName", e.target.value)} />
          <div>
            <Input
              id="unit-kind"
              label="Tipo"
              list="unit-kind-options"
              placeholder="Pousada, Hotel boutique…"
              value={form.kind}
              onChange={(e) => set("kind", e.target.value)}
            />
            <datalist id="unit-kind-options">
              <option value="Pousada" />
              <option value="Hotel" />
              <option value="Hotel boutique" />
              <option value="Resort" />
              <option value="Chalés" />
            </datalist>
          </div>
          <Input id="unit-city" label="Cidade" value={form.city} onChange={(e) => set("city", e.target.value)} />
          <Input id="unit-state" label="UF" maxLength={2} value={form.state} onChange={(e) => set("state", e.target.value)} />
          <Input
            id="unit-whatsapp"
            label="WhatsApp (exibição)"
            placeholder="(54) 99999-0000"
            value={form.whatsappLabel}
            onChange={(e) => set("whatsappLabel", e.target.value)}
          />
          <Input
            id="unit-rooms"
            label="Quartos"
            type="number"
            inputMode="numeric"
            min={0}
            value={form.roomsCount}
            onChange={(e) => set("roomsCount", e.target.value)}
          />
        </div>
        <Input
          id="unit-booking"
          label="Link de reserva"
          type="url"
          placeholder="https://"
          value={form.bookingUrl}
          onChange={(e) => set("bookingUrl", e.target.value)}
        />
        <div>
          <label htmlFor="unit-status" className={labelClass}>Situação</label>
          <select
            id="unit-status"
            value={form.status}
            onChange={(e) => set("status", e.target.value as Doc<"units">["status"])}
            className={selectClass}
          >
            <option value="active">Ativa</option>
            <option value="onboarding">Em implantação</option>
            <option value="inactive">Inativa</option>
          </select>
        </div>
        <ColorField label="Cor" value={form.color} onChange={(c) => set("color", c)} />
        <div>
          <label htmlFor="unit-description" className={labelClass}>Descrição</label>
          <textarea
            id="unit-description"
            rows={2}
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            className={textareaClass}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Salvando…" : "Salvar"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// --- Setores ---------------------------------------------------------------

type DepartmentRow = NonNullable<ReturnType<typeof useDepartments>>[number];
function useDepartments(organizationId: Id<"organizations">) {
  return useQuery(api.departments.listDepartments, { organizationId });
}

function DepartmentsCard({
  organizationId,
  canManage,
  showUnits,
}: {
  organizationId: Id<"organizations">;
  canManage: boolean;
  showUnits: boolean;
}) {
  const departments = useDepartments(organizationId);
  const units = useQuery(api.units.listUnits, showUnits ? { organizationId } : "skip");
  const deleteDepartment = useMutation(api.departments.deleteDepartment);
  const [editing, setEditing] = useState<DepartmentRow | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DepartmentRow | null>(null);
  const unitName = useMemo(() => new Map((units ?? []).map((u) => [u._id as string, u.name])), [units]);

  const onDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deleteDepartment({ departmentId: confirmDelete._id });
      toast.success("Setor excluído");
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível excluir o setor"));
    }
    setConfirmDelete(null);
  };

  return (
    <Card>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-text-primary">Setores</h3>
          <p className="mt-1 text-sm text-text-secondary">Filas de atendimento e quem responde em cada uma.</p>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus size={16} aria-hidden="true" /> Novo setor
          </Button>
        )}
      </div>

      {departments === undefined ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : departments.length === 0 ? (
        <p className="py-4 text-sm text-text-muted">Nenhum setor cadastrado ainda.</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {departments.map((d) => {
            const unitsLabel =
              showUnits && d.unitIds && d.unitIds.length > 0
                ? d.unitIds.map((id) => unitName.get(id)).filter(Boolean).join(", ")
                : "Todas as unidades";
            return (
              <li key={d._id} className="flex items-center gap-3 py-3">
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                  style={{ background: `${d.color}1f`, color: d.color }}
                >
                  <DepartmentIcon name={d.icon} size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-primary">
                    <span className="truncate">{d.name}</span>
                    {d.isEntry && (
                      <Badge variant="brand">
                        <Inbox size={11} className="mr-1 inline" aria-hidden="true" />
                        Fila de entrada
                      </Badge>
                    )}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-text-muted">
                    {d.members.length === 0
                      ? "Sem membros"
                      : `${d.members.length} ${d.members.length === 1 ? "membro" : "membros"}: ${d.members.map((m) => m.name.split(" ")[0]).join(", ")}`}
                    {showUnits ? ` · ${unitsLabel}` : ""}
                    {` · ${d.openCount >= 500 ? "500+" : d.openCount} abertas`}
                  </p>
                </div>
                {canManage && (
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => setEditing(d)}
                      className="flex h-11 w-11 items-center justify-center rounded-full text-text-muted hover:bg-surface-overlay hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      aria-label={`Editar ${d.name}`}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(d)}
                      className="flex h-11 w-11 items-center justify-center rounded-full text-text-muted hover:bg-semantic-error/10 hover:text-semantic-error focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      aria-label={`Excluir ${d.name}`}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {editing && (
        <DepartmentModal
          organizationId={organizationId}
          department={editing === "new" ? null : editing}
          units={showUnits ? units ?? [] : []}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={onDelete}
        title="Excluir setor?"
        description={`"${confirmDelete?.name ?? ""}" será removido. Setores com conversas não podem ser excluídos — transfira as conversas antes.`}
        confirmLabel="Excluir"
        variant="danger"
      />
    </Card>
  );
}

interface TeamMemberOption {
  _id: Id<"teamMembers">;
  name: string;
  type: "human" | "ai";
  removed?: boolean;
}

function DepartmentModal({
  organizationId,
  department,
  units,
  onClose,
}: {
  organizationId: Id<"organizations">;
  department: DepartmentRow | null;
  units: Doc<"units">[];
  onClose: () => void;
}) {
  const createDepartment = useMutation(api.departments.createDepartment);
  const updateDepartment = useMutation(api.departments.updateDepartment);
  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId }) as TeamMemberOption[] | undefined;

  const [name, setName] = useState(department?.name ?? "");
  const [description, setDescription] = useState(department?.description ?? "");
  const [color, setColor] = useState(department?.color ?? COLOR_PRESETS[1]);
  const [icon, setIcon] = useState(department?.icon ?? "Headphones");
  const [memberIds, setMemberIds] = useState<Id<"teamMembers">[]>(() => department?.memberIds ?? []);
  const [unitIds, setUnitIds] = useState<Id<"units">[]>(() => department?.unitIds ?? []);
  const [isEntry, setIsEntry] = useState(department?.isEntry ?? false);
  const [saving, setSaving] = useState(false);

  const options = assignableMembers(teamMembers, memberIds);
  const toggleIn = <T,>(list: T[], id: T) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Informe o nome do setor");
      return;
    }
    const fields = {
      name: name.trim(),
      description: description.trim(),
      color,
      icon,
      memberIds,
      unitIds,
      isEntry,
    };
    setSaving(true);
    try {
      if (department) {
        await updateDepartment({ departmentId: department._id, ...fields });
        toast.success("Setor atualizado");
      } else {
        await createDepartment({ organizationId, ...fields });
        toast.success("Setor criado");
      }
      onClose();
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível salvar o setor"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={department ? "Editar setor" : "Novo setor"}>
      <form onSubmit={submit} className="space-y-4">
        <Input id="dept-name" label="Nome" placeholder="Ex.: Reservas" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        <div>
          <label htmlFor="dept-description" className={labelClass}>Descrição</label>
          <textarea
            id="dept-description"
            rows={2}
            placeholder="O que chega para este setor"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={textareaClass}
          />
        </div>

        <div>
          <span className={labelClass}>Ícone</span>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Ícone do setor">
            {Object.entries(DEPARTMENT_ICONS).map(([key, { icon: Icon, label }]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={icon === key}
                aria-label={label}
                title={label}
                onClick={() => setIcon(key)}
                className={cn(
                  "flex h-11 w-11 items-center justify-center rounded-lg border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                  icon === key
                    ? "border-brand-500 bg-brand-500/10 text-brand-500"
                    : "border-border text-text-muted hover:text-text-primary"
                )}
              >
                <Icon size={18} aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>

        <ColorField label="Cor" value={color} onChange={setColor} />

        <div>
          <span className={labelClass}>Membros</span>
          {teamMembers === undefined ? (
            <Skeleton className="h-24 w-full" />
          ) : options.length === 0 ? (
            <p className="text-sm text-text-muted">Nenhum membro na equipe.</p>
          ) : (
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-field border border-border bg-surface-sunken p-2">
              {options.map((m) => {
                const selected = memberIds.includes(m._id);
                return (
                  <button
                    key={m._id}
                    type="button"
                    role="checkbox"
                    aria-checked={selected}
                    onClick={() => setMemberIds((ids) => toggleIn(ids, m._id))}
                    className={cn(
                      "flex w-full min-h-[44px] items-center gap-2.5 rounded-lg px-2 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                      selected ? "bg-brand-500/10 text-text-primary" : "text-text-secondary hover:bg-surface-raised"
                    )}
                  >
                    <Avatar name={m.name} type={m.type} size="sm" />
                    <span className="flex-1 truncate">{m.removed ? `${m.name} (removido)` : m.name}</span>
                    {m.type === "ai" && <Badge variant="warning">IA</Badge>}
                    <span
                      className={cn(
                        "h-4 w-4 shrink-0 rounded border",
                        selected ? "border-brand-500 bg-brand-500" : "border-border-strong"
                      )}
                      aria-hidden="true"
                    />
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {units.length > 0 && (
          <div>
            <span className={labelClass}>Unidades atendidas</span>
            <p className="mb-2 text-xs text-text-muted">Nenhuma marcada = atende todas.</p>
            <div className="flex flex-wrap gap-2">
              {units.map((u) => {
                const selected = unitIds.includes(u._id);
                return (
                  <button
                    key={u._id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setUnitIds((ids) => toggleIn(ids, u._id))}
                    className={cn(
                      "inline-flex min-h-[36px] items-center gap-1.5 rounded-full border px-3 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                      selected
                        ? "border-brand-500 bg-brand-500/10 text-text-primary"
                        : "border-border text-text-secondary hover:text-text-primary"
                    )}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ background: u.color }} aria-hidden="true" />
                    {u.shortName || u.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <Checkbox
          id="dept-entry"
          checked={isEntry}
          onChange={(e) => setIsEntry(e.target.checked)}
          label="Fila de entrada"
          description="Conversas novas, ainda sem setor, aparecem para este setor."
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Salvando…" : "Salvar"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// --- Investimento em mídia -------------------------------------------------

const PLATFORM_LABELS: Record<AdSpendPlatform, string> = { meta: "Meta", google: "Google", other: "Outra" };

function AdSpendCard({
  organizationId,
  canManage,
  showUnits,
}: {
  organizationId: Id<"organizations">;
  canManage: boolean;
  showUnits: boolean;
}) {
  const { can } = usePermissions(organizationId);
  const canView = can("reports", "view");
  const [today] = useState(() => localDateString(new Date()));
  const [from, setFrom] = useState(() => lastNDays(30, today).from);
  const [to, setTo] = useState(today);
  const validRange = !!from && !!to && from <= to;
  const rows = useQuery(api.adSpend.listAdSpend, canView && validRange ? { organizationId, from, to } : "skip");
  const units = useQuery(api.units.listUnits, showUnits ? { organizationId } : "skip");
  const deleteAdSpend = useMutation(api.adSpend.deleteAdSpend);
  const [adding, setAdding] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Doc<"adSpend"> | null>(null);

  const unitById = useMemo(() => new Map((units ?? []).map((u) => [u._id as string, u])), [units]);
  const sorted = useMemo(
    () => [...(rows ?? [])].sort((a, b) => b.date.localeCompare(a.date) || a.campaignName.localeCompare(b.campaignName)),
    [rows]
  );
  const total = sorted.reduce((s, r) => s + r.amount, 0);

  const onDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deleteAdSpend({ adSpendId: confirmDelete._id });
      toast.success("Linha excluída");
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível excluir"));
    }
    setConfirmDelete(null);
  };

  if (!canView) return null;

  return (
    <Card>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-text-primary">Investimento em mídia</h3>
          <p className="mt-1 text-sm text-text-secondary">Quanto foi gasto por dia em cada campanha — base do CAC e do ROAS.</p>
        </div>
        {canManage && (
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="secondary" onClick={() => setPasting(true)}>
              <ClipboardPaste size={16} aria-hidden="true" /> Colar CSV
            </Button>
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus size={16} aria-hidden="true" /> Adicionar
            </Button>
          </div>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor="spend-from" className="text-text-muted">De</label>
        <input id="spend-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={cn(selectClass, "w-auto")} />
        <label htmlFor="spend-to" className="text-text-muted">até</label>
        <input id="spend-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={cn(selectClass, "w-auto")} />
      </div>

      {rows === undefined && validRange ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : sorted.length === 0 ? (
        <p className="py-4 text-sm text-text-muted">
          Nenhum investimento registrado neste período. Use “Colar CSV” para trazer uma planilha de uma vez.
        </p>
      ) : (
        <div className="-mx-4 overflow-x-auto md:mx-0">
          <table className="w-full min-w-[560px] text-sm">
            <caption className="sr-only">Investimento em mídia no período</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th scope="col" className="px-3 py-2 pl-4 font-medium md:pl-3">Data</th>
                <th scope="col" className="px-3 py-2 font-medium">Plataforma</th>
                <th scope="col" className="px-3 py-2 font-medium">Campanha</th>
                {showUnits && <th scope="col" className="px-3 py-2 font-medium">Unidade</th>}
                <th scope="col" className="px-3 py-2 text-right font-medium">Valor</th>
                {canManage && <th scope="col" className="w-12 px-3 py-2"><span className="sr-only">Ações</span></th>}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const unit = r.unitId ? unitById.get(r.unitId) : undefined;
                return (
                  <tr key={r._id} className="border-b border-border-subtle last:border-0">
                    <td className="whitespace-nowrap px-3 py-2 pl-4 tabular-nums text-text-secondary md:pl-3">{formatFullDate(r.date)}</td>
                    <td className="px-3 py-2 text-text-secondary">{PLATFORM_LABELS[r.platform]}</td>
                    <td className="max-w-[220px] truncate px-3 py-2 text-text-primary" title={r.campaignName}>{r.campaignName}</td>
                    {showUnits && (
                      <td className="px-3 py-2 text-text-secondary">
                        {unit ? (
                          <span className="flex items-center gap-1.5">
                            <span className="h-2 w-2 rounded-full" style={{ background: unit.color }} aria-hidden="true" />
                            {unit.shortName || unit.name}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    )}
                    <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums text-text-primary">{formatBRL(r.amount)}</td>
                    {canManage && (
                      <td className="px-1 py-1 text-right">
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(r)}
                          className="inline-flex h-11 w-11 items-center justify-center rounded-full text-text-muted hover:bg-semantic-error/10 hover:text-semantic-error focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                          aria-label={`Excluir ${r.campaignName} de ${formatFullDate(r.date)}`}
                        >
                          <Trash2 size={15} />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-border-strong font-semibold text-text-primary">
                <td className="px-3 py-2.5 pl-4 md:pl-3" colSpan={showUnits ? 4 : 3}>
                  Total ({sorted.length} {sorted.length === 1 ? "linha" : "linhas"})
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{formatBRL(total)}</td>
                {canManage && <td />}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {adding && (
        <AdSpendModal organizationId={organizationId} units={units ?? []} today={today} onClose={() => setAdding(false)} />
      )}
      {pasting && (
        <PasteCsvModal organizationId={organizationId} units={units ?? []} onClose={() => setPasting(false)} />
      )}
      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={onDelete}
        title="Excluir investimento?"
        description={
          confirmDelete
            ? `${confirmDelete.campaignName} em ${formatFullDate(confirmDelete.date)} (${formatBRL(confirmDelete.amount)}).`
            : undefined
        }
        confirmLabel="Excluir"
        variant="danger"
      />
    </Card>
  );
}

function AdSpendModal({
  organizationId,
  units,
  today,
  onClose,
}: {
  organizationId: Id<"organizations">;
  units: Doc<"units">[];
  today: string;
  onClose: () => void;
}) {
  const upsertAdSpend = useMutation(api.adSpend.upsertAdSpend);
  const [date, setDate] = useState(today);
  const [platform, setPlatform] = useState<AdSpendPlatform>("meta");
  const [campaignName, setCampaignName] = useState("");
  const [unitId, setUnitId] = useState<Id<"units"> | "">("");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = Number(amount.replace(/\./g, "").replace(",", "."));
    if (!campaignName.trim()) return toast.error("Informe a campanha");
    if (!Number.isFinite(value) || value < 0) return toast.error("Valor inválido");
    setSaving(true);
    try {
      await upsertAdSpend({
        organizationId,
        date,
        platform,
        campaignName: campaignName.trim(),
        amount: value,
        ...(unitId ? { unitId } : {}),
      });
      toast.success("Investimento registrado");
      onClose();
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível registrar"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Adicionar investimento">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-text-muted">
          Mesma data, plataforma, campanha e unidade substitui o valor já registrado.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input id="spend-date" label="Data" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          <div>
            <label htmlFor="spend-platform" className={labelClass}>Plataforma</label>
            <select id="spend-platform" value={platform} onChange={(e) => setPlatform(e.target.value as AdSpendPlatform)} className={selectClass}>
              <option value="meta">Meta (Facebook/Instagram)</option>
              <option value="google">Google</option>
              <option value="other">Outra</option>
            </select>
          </div>
        </div>
        <Input id="spend-campaign" label="Campanha" value={campaignName} onChange={(e) => setCampaignName(e.target.value)} required />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {units.length > 0 && (
            <div>
              <label htmlFor="spend-unit" className={labelClass}>Unidade</label>
              <select id="spend-unit" value={unitId} onChange={(e) => setUnitId(e.target.value as Id<"units"> | "")} className={selectClass}>
                <option value="">Todas / nenhuma</option>
                {units.map((u) => (
                  <option key={u._id} value={u._id}>{u.name}</option>
                ))}
              </select>
            </div>
          )}
          <Input
            id="spend-amount"
            label="Valor (R$)"
            inputMode="decimal"
            placeholder="0,00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Salvando…" : "Salvar"}</Button>
        </div>
      </form>
    </Modal>
  );
}

const MAX_IMPORT_ROWS = 1000;

function PasteCsvModal({
  organizationId,
  units,
  onClose,
}: {
  organizationId: Id<"organizations">;
  units: Doc<"units">[];
  onClose: () => void;
}) {
  const importAdSpendRows = useMutation(api.adSpend.importAdSpendRows);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const parsed = useMemo(() => parseAdSpendCsv(text, units), [text, units]);
  const total = parsed.rows.reduce((s, r) => s + r.amount, 0);
  const tooMany = parsed.rows.length > MAX_IMPORT_ROWS;

  const submit = async () => {
    if (parsed.rows.length === 0 || tooMany) return;
    setSaving(true);
    try {
      const result = await importAdSpendRows({
        organizationId,
        rows: parsed.rows.map((r) => ({
          date: r.date,
          platform: r.platform,
          campaignName: r.campaignName,
          amount: r.amount,
          ...(r.unitId ? { unitId: r.unitId as Id<"units"> } : {}),
        })),
      });
      toast.success(`${result.created} linhas criadas, ${result.updated} atualizadas`);
      onClose();
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível importar"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Colar investimento (CSV)" className="sm:max-w-2xl">
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          Uma linha por dia e campanha, no formato{" "}
          <code className="rounded bg-surface-sunken px-1.5 py-0.5 text-xs text-text-primary">data;plataforma;campanha;unidade;valor</code>.
          A unidade pode ficar vazia; o valor aceita “1.234,56”.
        </p>
        <label htmlFor="spend-csv" className="sr-only">Conteúdo CSV</label>
        <textarea
          id="spend-csv"
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"data;plataforma;campanha;unidade;valor\n01/09/2026;meta;Primavera Serra;Pousada Vale;150,00"}
          className={cn(textareaClass, "font-mono text-sm")}
          spellCheck={false}
        />
        {text.trim() && (
          <div className="space-y-2 text-sm">
            <p className="text-text-secondary">
              <strong className="text-text-primary tabular-nums">{parsed.rows.length}</strong> linhas válidas ·{" "}
              <span className="tabular-nums">{formatBRL(total)}</span>
              {parsed.errors.length > 0 && (
                <span className="text-semantic-error"> · {parsed.errors.length} com erro (serão ignoradas)</span>
              )}
            </p>
            {tooMany && (
              <p className="text-semantic-error">Máximo de {MAX_IMPORT_ROWS} linhas por vez — divida a planilha.</p>
            )}
            {parsed.errors.length > 0 && (
              <ul className="max-h-32 space-y-0.5 overflow-y-auto rounded-field border border-semantic-error/30 bg-semantic-error/5 p-2 text-xs text-text-secondary">
                {parsed.errors.slice(0, 20).map((e) => (
                  <li key={e.line}>
                    <span className="tabular-nums text-text-muted">Linha {e.line}:</span> {e.message}
                  </li>
                ))}
                {parsed.errors.length > 20 && <li className="text-text-muted">…e mais {parsed.errors.length - 20}</li>}
              </ul>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="button" onClick={submit} disabled={saving || parsed.rows.length === 0 || tooMany}>
            {saving ? "Importando…" : `Importar ${parsed.rows.length} ${parsed.rows.length === 1 ? "linha" : "linhas"}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
