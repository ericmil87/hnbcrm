import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import {
  MAX_REQUIREMENTS, MAX_VARIANTS, newRequirement, newVariant, type RequirementForm, type ResourceKind, type ServiceErrorKey, type ServiceForm, type FormErrors,
} from "@/lib/agendaConfigForms";
import { VOCAB } from "@/lib/vocab";
import { NoticeField } from "./NoticeField";

export interface ResourceChoice {
  _id: string;
  name: string;
  kind: ResourceKind;
  active: boolean;
}

interface ServiceFormFieldsProps {
  value: ServiceForm;
  onChange: (next: ServiceForm) => void;
  errors?: FormErrors<ServiceErrorKey>;
  disabled?: boolean;
  resources: ResourceChoice[];
}

const DURATION_PRESETS = [15, 30, 45, 60, 90];

function SwitchRow({ title, description, checked, onChange, disabled }: { title: string; description?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary">{title}</p>
        {description && <p className="mt-0.5 text-sm text-text-muted">{description}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} label={title} hideLabel disabled={disabled} />
    </div>
  );
}

function NumberInput({ label, value, onChange, hint, error, placeholder, disabled }: { label: string; value: string; onChange: (v: string) => void; hint?: string; error?: string; placeholder?: string; disabled?: boolean }) {
  return (
    <FormField label={label} hint={hint} error={error}>
      {(aria) => <Input {...aria} type="number" inputMode="numeric" min={0} value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />}
    </FormField>
  );
}

/** Campos do serviço (controlado, sem Convex). */
export function ServiceFormFields({ value, onChange, errors = {}, disabled, resources }: ServiceFormFieldsProps) {
  const set = (patch: Partial<ServiceForm>) => onChange({ ...value, ...patch });
  const setReq = (i: number, patch: Partial<RequirementForm>) => set({ requirements: value.requirements.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) });

  return (
    <div className="space-y-6">
      <FormField label="Nome do serviço" error={errors.name}>
        {(aria) => <Input {...aria} value={value.name} maxLength={60} disabled={disabled} placeholder="Sessão, consulta, corte..." onChange={(e) => set({ name: e.target.value })} />}
      </FormField>

      <div className="space-y-2">
        <NumberInput label="Duração (minutos)" value={value.durationMin} error={errors.durationMin} disabled={disabled} onChange={(durationMin) => set({ durationMin })} />
        <div className="flex flex-wrap gap-2" role="group" aria-label="Durações comuns">
          {DURATION_PRESETS.map((m) => (
            <Button key={`dur:${m}`} size="sm" variant={value.durationMin === String(m) ? "primary" : "secondary"} disabled={disabled} onClick={() => set({ durationMin: String(m) })}>
              {m} min
            </Button>
          ))}
        </div>
      </div>

      <section className="space-y-3">
        <div>
          <p className="text-sm font-medium text-text-primary">Variações de duração</p>
          <p className="text-sm text-text-muted">Para o mesmo serviço durar diferente, como primeira consulta (60 min) e retorno (30 min).</p>
        </div>
        {value.variants.map((v, i) => (
          <div key={`variant:${i}`} className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <FormField label={`Variação ${i + 1}`}>
                {(aria) => (
                  <Input {...aria} value={v.name} maxLength={60} disabled={disabled} placeholder="Retorno" onChange={(e) => set({ variants: value.variants.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)) })} />
                )}
              </FormField>
            </div>
            <div className="w-24 shrink-0">
              <FormField label="Minutos">
                {(aria) => (
                  <Input {...aria} type="number" inputMode="numeric" value={v.durationMin} disabled={disabled} onChange={(e) => set({ variants: value.variants.map((x, idx) => (idx === i ? { ...x, durationMin: e.target.value } : x)) })} />
                )}
              </FormField>
            </div>
            <Button iconOnly size="md" variant="ghost" aria-label={`Remover variação ${i + 1}`} disabled={disabled} onClick={() => set({ variants: value.variants.filter((_, idx) => idx !== i) })}>
              <Trash2 size={16} aria-hidden="true" />
            </Button>
          </div>
        ))}
        {errors.variants && <p role="alert" className="text-sm text-semantic-error">{errors.variants}</p>}
        {value.variants.length < MAX_VARIANTS && (
          <Button size="sm" variant="secondary" disabled={disabled} onClick={() => set({ variants: [...value.variants, newVariant()] })}>
            <Plus size={14} aria-hidden="true" /> Adicionar variação
          </Button>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <p className="text-sm font-medium text-text-primary">Intervalos</p>
          <p className="text-sm text-text-muted">Tempo livre ao redor do atendimento (arrumar a sala, anotar) e de quanto em quanto tempo os horários aparecem.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberInput label="Folga antes (min)" value={value.bufferBeforeMin} placeholder="0" error={errors.bufferBeforeMin} disabled={disabled} onChange={(bufferBeforeMin) => set({ bufferBeforeMin })} />
          <NumberInput label="Folga depois (min)" value={value.bufferAfterMin} placeholder="0" error={errors.bufferAfterMin} disabled={disabled} onChange={(bufferAfterMin) => set({ bufferAfterMin })} />
          <NumberInput label="Entre horários (min)" value={value.slotIntervalMin} placeholder="Padrão da agenda" error={errors.slotIntervalMin} disabled={disabled} onChange={(slotIntervalMin) => set({ slotIntervalMin })} />
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <p className="text-sm font-medium text-text-primary">O que este serviço exige</p>
          <p className="text-sm text-text-muted">Cada item é ocupado durante o atendimento. Exemplo: 1 sala e 1 profissional.</p>
        </div>
        {value.requirements.map((r, i) => {
          const options = resources.filter((x) => x.kind === r.kind && (x.active || r.resourceIds.includes(x._id)));
          const kindTitle = VOCAB.scheduling.resource[r.kind];
          return (
            <div key={`req:${i}`} className="space-y-3 rounded-card border border-border p-3">
              <div className="flex items-end gap-2">
                <div className="w-40 shrink-0">
                  <FormField label="Tipo" htmlFor={`req-kind-${i}`}>
                    <Select id={`req-kind-${i}`} value={r.kind} disabled={disabled} onValueChange={(kind) => setReq(i, { kind: kind as ResourceKind, resourceIds: [], exclusive: false })} options={(["person", "room", "equipment"] as ResourceKind[]).map((k) => ({ value: k, label: VOCAB.scheduling.resource[k].title }))} />
                  </FormField>
                </div>
                <div className="min-w-0 flex-1">
                  <FormField label="Nome do item">
                    {(aria) => <Input {...aria} value={r.role} maxLength={40} disabled={disabled} onChange={(e) => setReq(i, { role: e.target.value })} />}
                  </FormField>
                </div>
                {value.requirements.length > 1 && (
                  <Button iconOnly size="md" variant="ghost" aria-label={`Remover item ${r.role || i + 1}`} disabled={disabled} onClick={() => set({ requirements: value.requirements.filter((_, idx) => idx !== i) })}>
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>
                )}
              </div>
              <FormField label="Quais podem ser usados" htmlFor={`req-which-${i}`}>
                <Select
                  id={`req-which-${i}`}
                  value={r.resourceIds.length === 0 ? "any" : "some"}
                  disabled={disabled}
                  onValueChange={(v) => setReq(i, { resourceIds: v === "any" ? [] : options.slice(0, 1).map((x) => x._id) })}
                  options={[
                    { value: "any", label: `Qualquer ${kindTitle.one}` },
                    { value: "some", label: `Só ${kindTitle.many} que eu escolher`, disabled: options.length === 0 },
                  ]}
                />
              </FormField>
              {r.resourceIds.length > 0 && (
                <div role="group" aria-label={`Escolha: ${r.role}`} className="grid gap-2 sm:grid-cols-2">
                  {options.map((o) => (
                    <label key={`req:${i}:${o._id}`} className="flex min-h-11 items-center gap-2 rounded-field border border-border px-3 text-sm text-text-primary">
                      <input
                        type="checkbox"
                        checked={r.resourceIds.includes(o._id)}
                        disabled={disabled}
                        onChange={() => {
                          const next = r.resourceIds.includes(o._id) ? r.resourceIds.filter((x) => x !== o._id) : [...r.resourceIds, o._id];
                          setReq(i, { resourceIds: next.length > 0 ? next : r.resourceIds });
                        }}
                      />
                      {o.name}
                    </label>
                  ))}
                </div>
              )}
              {r.kind !== "person" && (
                <div className="space-y-3">
                  <SwitchRow title={`Ocupa ${kindTitle.one} inteira`} description="Ninguém mais entra no horário, mesmo que comporte mais pessoas." checked={r.exclusive} disabled={disabled} onChange={(exclusive) => setReq(i, { exclusive })} />
                  {!r.exclusive && <NumberInput label="Vagas que ocupa" hint="Em branco = 1. Um casal numa sala dupla ocupa 2." value={r.units} disabled={disabled} onChange={(units) => setReq(i, { units })} />}
                </div>
              )}
            </div>
          );
        })}
        {errors.requirements && <p role="alert" className="text-sm text-semantic-error">{errors.requirements}</p>}
        {value.requirements.length < MAX_REQUIREMENTS && (
          <div className="flex flex-wrap gap-2">
            {(["person", "room", "equipment"] as ResourceKind[]).map((k) => (
              <Button key={`addreq:${k}`} size="sm" variant="secondary" disabled={disabled} onClick={() => set({ requirements: [...value.requirements, newRequirement(k, value.requirements.map((x) => x.role))] })}>
                <Plus size={14} aria-hidden="true" /> {VOCAB.scheduling.resource[k].title}
              </Button>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <p className="text-sm font-medium text-text-primary">Quem pode marcar</p>
        <SwitchRow title="A IA pode oferecer este serviço" description="Ela só marca ou propõe o que estiver ligado aqui." checked={value.aiBookable} disabled={disabled} onChange={(aiBookable) => set({ aiBookable })} />
        <SwitchRow title="O link público pode oferecer" description="Para clientes marcarem sem falar com a equipe." checked={value.publicBookable} disabled={disabled} onChange={(publicBookable) => set({ publicBookable })} />
        <SwitchRow title="O cliente pode remarcar" checked={value.clientCanReschedule} disabled={disabled} onChange={(clientCanReschedule) => set({ clientCanReschedule })} />
        {value.clientCanReschedule && (
          <NoticeField label="Antecedência para remarcar" value={value.minRescheduleNotice} error={errors.minRescheduleNotice} placeholder="Sem mínimo" disabled={disabled} onChange={(minRescheduleNotice) => set({ minRescheduleNotice })} />
        )}
        <SwitchRow title="O cliente pode cancelar" checked={value.clientCanCancel} disabled={disabled} onChange={(clientCanCancel) => set({ clientCanCancel })} />
      </section>

      <CollapsibleSection title="Avançado">
        <div className="space-y-4 pb-3">
          <NoticeField label="Antecedência mínima para marcar" hint="Vale para a IA e o link público. Em branco = a da agenda." value={value.minNotice} error={errors.minNotice} placeholder="Padrão" disabled={disabled} onChange={(minNotice) => set({ minNotice })} />
          <NumberInput label="Até quantos dias à frente" hint="Em branco = o da agenda." value={value.maxAdvanceDays} error={errors.maxAdvanceDays} disabled={disabled} onChange={(maxAdvanceDays) => set({ maxAdvanceDays })} />
          <NumberInput label="Máximo de horários ativos por cliente" hint="Em branco = sem limite para a equipe; a IA e o link usam 1." value={value.maxActivePerContact} error={errors.maxActivePerContact} disabled={disabled} onChange={(maxActivePerContact) => set({ maxActivePerContact })} />
        </div>
      </CollapsibleSection>
    </div>
  );
}
