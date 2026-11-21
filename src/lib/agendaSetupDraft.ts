/**
 * Agenda v2 (B1): rascunho editável do assistente de 3 passos. PURO e sem Convex.
 *
 * O servidor monta o rascunho do modelo (`previewTemplate`); o assistente deixa o dono ajustar nomes,
 * quantas pessoas cabem por sala, serviços, durações e o horário de funcionamento, e manda o resultado
 * para `applyTemplate({ templateKey, draft })`. O servidor revalida tudo pelas mesmas regras da edição
 * manual; aqui só se evita o ida-e-volta com mensagens claras.
 *
 * O horário de funcionamento é UM só (vale para todas as salas e profissionais do rascunho). Horário
 * diferente por pessoa se ajusta depois, em Salas e profissionais.
 */
import type { SchedTemplateDraft, TemplateResourceDraft, TemplateServiceDraft } from "../../convex/lib/schedTemplates";
import { MAX_BLOCK_MIN } from "../../convex/lib/schedConstants";
import { MAX_CAPACITY, nameKey, parseIntField, type ResourceKind } from "./agendaConfigForms";
import { weekErrors, weekFromWeekly, weeklyFromWeek, type WeekForm } from "./agendaWeek";

export const SETUP_MAX_RESOURCES = 30;
export const SETUP_MAX_SERVICES = 20;

export interface SetupResourceForm {
  ref: string;
  kind: ResourceKind;
  name: string;
  capacity: string;
  /** Mantido do modelo (profissional já ligado a alguém da equipe). */
  teamMemberId?: string;
  tags?: string[];
}
export interface SetupServiceForm {
  /** Campos do modelo que a tela não edita (folgas, passo, requisitos, IA). */
  base: TemplateServiceDraft;
  name: string;
  durationMin: string;
}
export interface SetupForm {
  templateKey: string;
  settings: SchedTemplateDraft["settings"];
  resources: SetupResourceForm[];
  services: SetupServiceForm[];
  week: WeekForm;
}

export function draftToForm(draft: SchedTemplateDraft): SetupForm {
  return {
    templateKey: draft.templateKey,
    settings: { ...draft.settings },
    resources: draft.resources.map((r) => ({
      ref: r.ref,
      kind: r.kind,
      name: r.name,
      capacity: String(r.capacity),
      ...(r.teamMemberId ? { teamMemberId: r.teamMemberId } : {}),
      ...(r.tags ? { tags: r.tags } : {}),
    })),
    services: draft.services.map((s) => ({ base: s, name: s.name, durationMin: String(s.durationMin) })),
    week: weekFromWeekly(draft.resources[0]?.weekly ?? []),
  };
}

/** Só chame com `setupErrors` vazio. Os requisitos que apontam para recurso removido perdem a referência. */
export function formToDraft(f: SetupForm): SchedTemplateDraft {
  const w = weeklyFromWeek(f.week);
  const weekly = w.ok ? w.weekly : [];
  const refs = new Set(f.resources.map((r) => r.ref));
  const resources: TemplateResourceDraft[] = f.resources.map((r) => ({
    ref: r.ref,
    kind: r.kind,
    name: r.name.replace(/\s+/g, " ").trim(),
    capacity: r.kind === "person" ? 1 : Number(r.capacity),
    ...(r.teamMemberId ? { teamMemberId: r.teamMemberId } : {}),
    weekly: weekly.map((x) => ({ ...x })),
    ...(r.tags ? { tags: r.tags } : {}),
  }));
  const services: TemplateServiceDraft[] = f.services.map((s) => ({
    ...s.base,
    name: s.name.replace(/\s+/g, " ").trim(),
    durationMin: Number(s.durationMin),
    requirements: s.base.requirements.map((req) => {
      const kept = req.resourceRefs?.filter((ref) => refs.has(ref));
      const { resourceRefs: _drop, ...rest } = req;
      void _drop;
      return kept && kept.length > 0 ? { ...rest, resourceRefs: kept } : rest;
    }),
  }));
  return { templateKey: f.templateKey, settings: { ...f.settings }, resources, services };
}

function nextRef(prefix: string, used: ReadonlyArray<string>): string {
  for (let n = 1; ; n++) if (!used.includes(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

export function addSetupResource(f: SetupForm, kind: ResourceKind): SetupForm {
  const ref = nextRef(kind === "person" ? "person" : kind === "room" ? "room" : "equip", f.resources.map((r) => r.ref));
  return { ...f, resources: [...f.resources, { ref, kind, name: "", capacity: "1" }] };
}

export function removeSetupResource(f: SetupForm, ref: string): SetupForm {
  return { ...f, resources: f.resources.filter((r) => r.ref !== ref) };
}

export function updateSetupResource(f: SetupForm, ref: string, patch: Partial<Pick<SetupResourceForm, "name" | "capacity">>): SetupForm {
  return { ...f, resources: f.resources.map((r) => (r.ref === ref ? { ...r, ...patch } : r)) };
}

export function addSetupService(f: SetupForm): SetupForm {
  const base: TemplateServiceDraft = f.services[0]
    ? { ...f.services[0].base, name: "", requirements: f.services[0].base.requirements.map((r) => ({ ...r })) }
    : { name: "", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0, requirements: [{ role: "Profissional", kind: "person" }] };
  return { ...f, services: [...f.services, { base, name: "", durationMin: String(base.durationMin) }] };
}

export function removeSetupService(f: SetupForm, index: number): SetupForm {
  return { ...f, services: f.services.filter((_, i) => i !== index) };
}

export function updateSetupService(f: SetupForm, index: number, patch: Partial<Pick<SetupServiceForm, "name" | "durationMin">>): SetupForm {
  return { ...f, services: f.services.map((s, i) => (i === index ? { ...s, ...patch } : s)) };
}

export interface SetupErrors {
  resources: Record<string, { name?: string; capacity?: string }>;
  services: Record<number, { name?: string; durationMin?: string }>;
  week?: string;
  /** Mensagens que não são de um campo (sem serviço, serviço sem sala...). */
  general: string[];
}

const KIND_MISSING: Record<ResourceKind, string> = {
  person: "Seus serviços precisam de ao menos um profissional. Adicione um.",
  room: "Seus serviços precisam de ao menos uma sala. Adicione uma.",
  equipment: "Seus serviços precisam de ao menos um equipamento. Adicione um.",
};

export function setupErrors(f: SetupForm): SetupErrors {
  const out: SetupErrors = { resources: {}, services: {}, general: [] };
  const seen = new Map<string, string>();
  for (const r of f.resources) {
    const name = r.name.replace(/\s+/g, " ").trim();
    const e: { name?: string; capacity?: string } = {};
    if (!name) e.name = "Dê um nome.";
    else if (name.length > 60) e.name = "No máximo 60 caracteres.";
    else if (seen.has(nameKey(name))) e.name = "Já existe um com esse nome.";
    if (name) seen.set(nameKey(name), r.ref);
    if (r.kind !== "person") {
      const c = parseIntField(r.capacity);
      if (c === undefined || !Number.isInteger(c) || c < 1 || c > MAX_CAPACITY) e.capacity = `Use um número de 1 a ${MAX_CAPACITY}.`;
    }
    if (e.name || e.capacity) out.resources[r.ref] = e;
  }

  if (f.services.length === 0) out.general.push("Cadastre ao menos um serviço.");
  const svcNames = new Set<string>();
  f.services.forEach((s, i) => {
    const name = s.name.replace(/\s+/g, " ").trim();
    const e: { name?: string; durationMin?: string } = {};
    if (!name) e.name = "Dê um nome.";
    else if (name.length > 60) e.name = "No máximo 60 caracteres.";
    else if (svcNames.has(nameKey(name))) e.name = "Já existe um serviço com esse nome.";
    if (name) svcNames.add(nameKey(name));
    const d = parseIntField(s.durationMin);
    if (d === undefined || !Number.isInteger(d) || d < 5 || d > MAX_BLOCK_MIN) e.durationMin = `Use de 5 a ${MAX_BLOCK_MIN} minutos.`;
    else if (d + s.base.bufferBeforeMin + s.base.bufferAfterMin > MAX_BLOCK_MIN) e.durationMin = `Com as folgas, passa de ${MAX_BLOCK_MIN} minutos.`;
    if (e.name || e.durationMin) out.services[i] = e;
  });

  const kinds = new Set(f.resources.map((r) => r.kind));
  const missing = new Set<ResourceKind>();
  for (const s of f.services) for (const req of s.base.requirements) if (!kinds.has(req.kind)) missing.add(req.kind);
  for (const k of missing) out.general.push(KIND_MISSING[k]);

  const days = weekErrors(f.week);
  const weekMsg = Object.values(days)[0];
  if (weekMsg) out.week = weekMsg;
  else if (!f.week.some((d) => d.length > 0)) out.week = "Marque pelo menos um dia de funcionamento.";
  return out;
}

export function hasSetupErrors(e: SetupErrors): boolean {
  return Object.keys(e.resources).length > 0 || Object.keys(e.services).length > 0 || e.week !== undefined || e.general.length > 0;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Resumo do passo 3: "3 salas (uma para 2 pessoas), 4 profissionais, 2 serviços". */
export function setupSummary(f: SetupForm): string[] {
  const rooms = f.resources.filter((r) => r.kind === "room");
  const people = f.resources.filter((r) => r.kind === "person");
  const equipment = f.resources.filter((r) => r.kind === "equipment");
  const lines: string[] = [];
  if (rooms.length > 0) {
    const multi = rooms.filter((r) => Number(r.capacity) > 1);
    const extra =
      multi.length === 0
        ? ""
        : ` (${multi.map((r) => `${r.name.trim() || "sala"} comporta ${Number(r.capacity)} pessoas ao mesmo tempo`).join("; ")})`;
    lines.push(`${plural(rooms.length, "sala", "salas")}${extra}`);
  }
  if (people.length > 0) lines.push(plural(people.length, "profissional", "profissionais"));
  if (equipment.length > 0) lines.push(plural(equipment.length, "equipamento", "equipamentos"));
  lines.push(plural(f.services.length, "serviço", "serviços"));
  return lines;
}
