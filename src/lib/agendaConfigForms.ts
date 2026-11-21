/**
 * Agenda v2 (B1): formulários de configuração (geral, serviço, sala/profissional). PURO e sem Convex:
 * valores do formulário <-> argumentos das mutations de `convex/schedulingConfig.ts`, validação local
 * que espelha o servidor (o servidor continua sendo a barreira) e detecção de mudanças.
 *
 * Escrita = MERGE no servidor: campo ausente mantém, `null` limpa. Por isso `*PatchArgs` manda SÓ o que
 * mudou e `null` para o que foi esvaziado; `*CreateArgs` manda o que importa para a criação.
 * Campos numéricos vivem como string no formulário (vazio = padrão do servidor).
 */
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { GRID_MINUTES_OPTIONS, MAX_BLOCK_MIN } from "../../convex/lib/schedConstants";
import type { SettingsView } from "../../convex/lib/schedViews";
import { sameWeek, weekErrors, weekFromWeekly, weekWith, weeklyFromWeek, WEEK_GENERAL_ERROR, type WeekForm, type WeeklyItem } from "./agendaWeek";

export type ResourceKind = "person" | "room" | "equipment";

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

/** Mesma chave de unicidade do servidor (`nameKey` de `schedConfigOps`): sem acento, minúscula, espaços colapsados. */
export function nameKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Inteiro de um campo de texto; vazio = `undefined`; lixo = `NaN`. */
export function parseIntField(raw: string): number | undefined {
  const t = raw.trim();
  if (t === "") return undefined;
  return /^\d+$/.test(t) ? Number(t) : Number.NaN;
}

function checkInt(raw: string, label: string, min: number, max: number, required = false): string | undefined {
  const n = parseIntField(raw);
  if (n === undefined) return required ? `${label} é obrigatório.` : undefined;
  if (!Number.isInteger(n) || n < min || n > max) return `${label} precisa ser um número inteiro entre ${min} e ${max}.`;
  return undefined;
}

export type FormErrors<K extends string> = Partial<Record<K, string>>;
const compact = <K extends string>(e: Partial<Record<K, string | undefined>>) =>
  Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) as FormErrors<K>;

// ---------------------------------------------------------------------------
// Antecedência: número + unidade (a tela mostra "2 horas", o servidor guarda minutos)
// ---------------------------------------------------------------------------

export type NoticeUnit = "min" | "h" | "d";
export const NOTICE_UNIT_MINUTES: Record<NoticeUnit, number> = { min: 1, h: 60, d: 1440 };
export const NOTICE_UNIT_LABELS: Record<NoticeUnit, string> = { min: "minutos", h: "horas", d: "dias" };
export const MAX_NOTICE_MIN = 43200;

export interface NoticeForm {
  value: string;
  unit: NoticeUnit;
}

/** Escolhe a maior unidade que divide exato: 120 -> 2 horas; 90 -> 90 minutos; 0 -> 0 minutos. */
export function noticeFromMinutes(minutes: number | undefined): NoticeForm {
  if (minutes === undefined) return { value: "", unit: "h" };
  if (minutes > 0 && minutes % 1440 === 0) return { value: String(minutes / 1440), unit: "d" };
  if (minutes > 0 && minutes % 60 === 0) return { value: String(minutes / 60), unit: "h" };
  return { value: String(minutes), unit: "min" };
}

/** `undefined` = campo vazio; `NaN` = inválido. */
export function noticeToMinutes(n: NoticeForm): number | undefined {
  const v = parseIntField(n.value);
  return v === undefined ? undefined : v * NOTICE_UNIT_MINUTES[n.unit];
}

function noticeError(n: NoticeForm, label: string): string | undefined {
  const v = noticeToMinutes(n);
  if (v === undefined) return undefined;
  if (!Number.isFinite(v) || v < 0 || v > MAX_NOTICE_MIN) return `${label} precisa ficar entre 0 e 30 dias.`;
  return undefined;
}

const sameNotice = (a: NoticeForm, b: NoticeForm) => noticeToMinutes(a) === noticeToMinutes(b);

// ---------------------------------------------------------------------------
// Geral (`schedSettings` + serviço padrão + funil)
// ---------------------------------------------------------------------------

export interface GeneralForm {
  gridMinutes: string;
  minNotice: NoticeForm;
  maxAdvanceDays: string;
  defaultServiceId: string;
  onScheduledStageId: string;
  onCompletedStageId: string;
  onNoShowStageId: string;
}

export type GeneralPatch = {
  gridMinutes?: number;
  minNoticeMin?: number;
  maxAdvanceDays?: number;
  humanConfirm?: { defaultServiceId: Id<"schedServices"> | null };
  funnel?: {
    onScheduledStageId?: Id<"stages"> | null;
    onCompletedStageId?: Id<"stages"> | null;
    onNoShowStageId?: Id<"stages"> | null;
  };
};

export function generalFromSettings(s: SettingsView): GeneralForm {
  return {
    gridMinutes: String(s.gridMinutes),
    minNotice: noticeFromMinutes(s.minNoticeMin),
    maxAdvanceDays: String(s.maxAdvanceDays),
    defaultServiceId: s.humanConfirm?.defaultServiceId ?? "",
    onScheduledStageId: s.funnel?.onScheduledStageId ?? "",
    onCompletedStageId: s.funnel?.onCompletedStageId ?? "",
    onNoShowStageId: s.funnel?.onNoShowStageId ?? "",
  };
}

export function generalErrors(f: GeneralForm): FormErrors<"gridMinutes" | "minNotice" | "maxAdvanceDays"> {
  const grid = parseIntField(f.gridMinutes);
  return compact({
    gridMinutes:
      grid === undefined || !(GRID_MINUTES_OPTIONS as readonly number[]).includes(grid)
        ? `O passo da grade precisa ser um destes: ${GRID_MINUTES_OPTIONS.join(", ")} minutos.`
        : undefined,
    minNotice: noticeError(f.minNotice, "A antecedência mínima") ?? (f.minNotice.value.trim() === "" ? "Informe a antecedência mínima (pode ser 0)." : undefined),
    maxAdvanceDays: checkInt(f.maxAdvanceDays, "A antecedência máxima", 1, 730, true),
  });
}

/** Só o que mudou; `null` limpa a etapa/serviço (volta ao padrão). */
export function generalToPatch(f: GeneralForm, saved: GeneralForm): GeneralPatch {
  const patch: GeneralPatch = {};
  if (f.gridMinutes !== saved.gridMinutes) patch.gridMinutes = Number(f.gridMinutes);
  if (!sameNotice(f.minNotice, saved.minNotice)) patch.minNoticeMin = noticeToMinutes(f.minNotice);
  if (f.maxAdvanceDays !== saved.maxAdvanceDays) patch.maxAdvanceDays = Number(f.maxAdvanceDays);
  if (f.defaultServiceId !== saved.defaultServiceId) {
    patch.humanConfirm = { defaultServiceId: f.defaultServiceId === "" ? null : (f.defaultServiceId as Id<"schedServices">) };
  }
  const funnel: NonNullable<GeneralPatch["funnel"]> = {};
  const stage = (v: string) => (v === "" ? null : (v as Id<"stages">));
  if (f.onScheduledStageId !== saved.onScheduledStageId) funnel.onScheduledStageId = stage(f.onScheduledStageId);
  if (f.onCompletedStageId !== saved.onCompletedStageId) funnel.onCompletedStageId = stage(f.onCompletedStageId);
  if (f.onNoShowStageId !== saved.onNoShowStageId) funnel.onNoShowStageId = stage(f.onNoShowStageId);
  if (Object.keys(funnel).length > 0) patch.funnel = funnel;
  return patch;
}

export const isEmptyPatch = (p: object): boolean => Object.keys(p).length === 0;

/** Etapas por funil, sem as de perda (a Agenda nunca move para etapa de perda; o servidor também recusa). A etapa já escolhida fica, mesmo de perda, para não sumir do seletor. */
export interface StageOption {
  _id: string;
  name: string;
  isClosedLost?: boolean;
}
export interface StageChoiceGroup {
  label: string;
  options: Array<{ value: string; label: string }>;
}
export function stageChoiceGroups(
  boards: ReadonlyArray<{ _id: string; name: string; stages: ReadonlyArray<StageOption> }>,
  selectedIds: ReadonlyArray<string> = []
): StageChoiceGroup[] {
  return boards
    .map((b) => ({
      label: b.name,
      options: b.stages
        .filter((s) => !s.isClosedLost || selectedIds.includes(s._id))
        .map((s) => ({ value: s._id, label: s.isClosedLost ? `${s.name} (etapa de perda)` : s.name })),
    }))
    .filter((g) => g.options.length > 0);
}

// ---------------------------------------------------------------------------
// Sala, profissional, equipamento
// ---------------------------------------------------------------------------

export interface ResourceForm {
  kind: ResourceKind;
  name: string;
  /** "Quantas pessoas ao mesmo tempo". Profissional = 1. */
  capacity: string;
  teamMemberId: string;
  week: WeekForm;
}

export const MAX_CAPACITY = 50;

/** Seg a sex, 09:00–12:00 e 14:00–18:00: ponto de partida editável. */
export function defaultBusinessWeek(): WeekForm {
  return weekWith([1, 2, 3, 4, 5], [
    { start: "09:00", end: "12:00" },
    { start: "14:00", end: "18:00" },
  ]);
}

export function newResourceForm(kind: ResourceKind): ResourceForm {
  return { kind, name: "", capacity: "1", teamMemberId: "", week: defaultBusinessWeek() };
}

export function resourceFormFrom(r: Pick<Doc<"schedResources">, "kind" | "name" | "capacity" | "teamMemberId" | "weekly">): ResourceForm {
  return {
    kind: r.kind,
    name: r.name,
    capacity: String(r.capacity),
    teamMemberId: r.teamMemberId ?? "",
    week: weekFromWeekly(r.weekly),
  };
}

export type ResourceErrorKey = "name" | "capacity" | "teamMemberId" | "week";

export function resourceErrors(
  f: ResourceForm,
  others: ReadonlyArray<{ _id: string; name: string }>,
  selfId?: string
): FormErrors<ResourceErrorKey> & { weekDays?: Record<number, string> } {
  const name = clean(f.name);
  let nameError: string | undefined;
  if (name.length < 1) nameError = "O nome é obrigatório.";
  else if (name.length > 60) nameError = "O nome pode ter no máximo 60 caracteres.";
  else if (others.some((o) => o._id !== selfId && nameKey(o.name) === nameKey(name))) nameError = `Já existe "${name}". Escolha outro nome.`;
  let capacityError: string | undefined;
  if (f.kind === "person") {
    if (f.capacity.trim() !== "1") capacityError = "Um profissional atende uma pessoa por vez.";
  } else capacityError = checkInt(f.capacity, "A capacidade", 1, MAX_CAPACITY, true);
  const days = weekErrors(f.week);
  const general = days[WEEK_GENERAL_ERROR];
  const firstDay = Object.entries(days).find(([d]) => Number(d) !== WEEK_GENERAL_ERROR)?.[1];
  const out = compact<ResourceErrorKey>({
    name: nameError,
    capacity: capacityError,
    teamMemberId: f.kind !== "person" && f.teamMemberId !== "" ? "Só um profissional pode ser ligado a alguém da equipe." : undefined,
    week: general ?? firstDay,
  });
  return Object.keys(days).length > 0 ? { ...out, weekDays: days } : out;
}

export function hasErrors(e: object): boolean {
  return Object.keys(e).length > 0;
}

export interface ResourceCreateArgs {
  kind: ResourceKind;
  name: string;
  capacity: number;
  teamMemberId?: Id<"teamMembers">;
  weekly: WeeklyItem[];
}

/** Só chame depois de `resourceErrors` vazio. */
export function resourceCreateArgs(f: ResourceForm): ResourceCreateArgs {
  const w = weeklyFromWeek(f.week);
  return {
    kind: f.kind,
    name: clean(f.name),
    capacity: f.kind === "person" ? 1 : Number(f.capacity),
    ...(f.teamMemberId !== "" ? { teamMemberId: f.teamMemberId as Id<"teamMembers"> } : {}),
    weekly: w.ok ? w.weekly : [],
  };
}

export interface ResourcePatchArgs {
  name?: string;
  capacity?: number;
  teamMemberId?: Id<"teamMembers"> | null;
  weekly?: WeeklyItem[];
}

/** Só o que mudou (o tipo não muda depois de criado). */
export function resourcePatchArgs(f: ResourceForm, saved: ResourceForm): ResourcePatchArgs {
  const patch: ResourcePatchArgs = {};
  if (clean(f.name) !== clean(saved.name)) patch.name = clean(f.name);
  if (f.capacity.trim() !== saved.capacity.trim()) patch.capacity = Number(f.capacity);
  if (f.teamMemberId !== saved.teamMemberId) patch.teamMemberId = f.teamMemberId === "" ? null : (f.teamMemberId as Id<"teamMembers">);
  if (!sameWeek(f.week, saved.week)) {
    const w = weeklyFromWeek(f.week);
    if (w.ok) patch.weekly = w.weekly;
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Serviço
// ---------------------------------------------------------------------------

export interface VariantForm {
  /** Fixa depois de criada (o agendamento guarda a chave). */
  key: string;
  name: string;
  durationMin: string;
}
export interface RequirementForm {
  role: string;
  kind: ResourceKind;
  /** Vazio = qualquer do tipo. */
  resourceIds: string[];
  /** Não editável aqui; preservado para a gravação não apagar. */
  tag: string;
  /** "Quantas vagas ocupa" (vazio = 1). */
  units: string;
  exclusive: boolean;
}
export interface ServiceForm {
  name: string;
  durationMin: string;
  variants: VariantForm[];
  bufferBeforeMin: string;
  bufferAfterMin: string;
  requirements: RequirementForm[];
  slotIntervalMin: string;
  minNotice: NoticeForm;
  maxAdvanceDays: string;
  maxActivePerContact: string;
  clientCanCancel: boolean;
  clientCanReschedule: boolean;
  minRescheduleNotice: NoticeForm;
  aiBookable: boolean;
  publicBookable: boolean;
}

export const REQUIREMENT_ROLE_DEFAULT: Record<ResourceKind, string> = { person: "Profissional", room: "Sala", equipment: "Equipamento" };
export const MAX_VARIANTS = 6;
export const MAX_REQUIREMENTS = 4;

export function newRequirement(kind: ResourceKind, used: ReadonlyArray<string> = []): RequirementForm {
  let role = REQUIREMENT_ROLE_DEFAULT[kind];
  for (let n = 2; used.some((u) => nameKey(u) === nameKey(role)); n++) role = `${REQUIREMENT_ROLE_DEFAULT[kind]} ${n}`;
  return { role, kind, resourceIds: [], tag: "", units: "", exclusive: false };
}

export function newServiceForm(): ServiceForm {
  return {
    name: "",
    durationMin: "60",
    variants: [],
    bufferBeforeMin: "",
    bufferAfterMin: "",
    requirements: [newRequirement("person")],
    slotIntervalMin: "",
    minNotice: { value: "", unit: "h" },
    maxAdvanceDays: "",
    maxActivePerContact: "",
    clientCanCancel: true,
    clientCanReschedule: true,
    minRescheduleNotice: { value: "", unit: "h" },
    aiBookable: true,
    publicBookable: false,
  };
}

const str = (n: number | undefined) => (n === undefined ? "" : String(n));

export function serviceFormFrom(s: Doc<"schedServices">): ServiceForm {
  return {
    name: s.name,
    durationMin: String(s.durationMin),
    variants: (s.variants ?? []).map((v) => ({ key: v.key, name: v.name, durationMin: String(v.durationMin) })),
    bufferBeforeMin: s.bufferBeforeMin > 0 ? String(s.bufferBeforeMin) : "",
    bufferAfterMin: s.bufferAfterMin > 0 ? String(s.bufferAfterMin) : "",
    requirements: s.requirements.map((r) => ({
      role: r.role,
      kind: r.kind,
      resourceIds: r.resourceIds ?? [],
      tag: r.tag ?? "",
      units: str(r.units),
      exclusive: r.exclusive === true,
    })),
    slotIntervalMin: str(s.slotIntervalMin),
    minNotice: noticeFromMinutes(s.minNoticeMin),
    maxAdvanceDays: str(s.maxAdvanceDays),
    maxActivePerContact: str(s.maxActivePerContact),
    clientCanCancel: s.clientCanCancel ?? true,
    clientCanReschedule: s.clientCanReschedule ?? true,
    minRescheduleNotice: noticeFromMinutes(s.minRescheduleNoticeMin),
    aiBookable: s.aiBookable ?? true,
    publicBookable: s.publicBookable ?? false,
  };
}

/** Chave estável de variação a partir do nome: minúscula, sem acento, `a-z0-9-`, até 20, única. */
export function variantKeyFor(name: string, taken: ReadonlyArray<string>): string {
  const base =
    nameKey(name)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 16) || "variacao";
  let key = base;
  for (let n = 2; taken.includes(key); n++) key = `${base}-${n}`.slice(0, 20);
  return key;
}

/** Variação nova ("Retorno" etc.); a chave sai do nome ao salvar (`withVariantKeys`). */
export function newVariant(durationMin = ""): VariantForm {
  return { key: "", name: "", durationMin };
}

/** Preenche a chave das variações novas (as existentes mantêm a sua). */
export function withVariantKeys(variants: VariantForm[]): VariantForm[] {
  const taken = variants.map((v) => v.key).filter((k) => k !== "");
  return variants.map((v) => {
    if (v.key !== "") return v;
    const key = variantKeyFor(v.name, taken);
    taken.push(key);
    return { ...v, key };
  });
}

export type ServiceErrorKey =
  | "name"
  | "durationMin"
  | "variants"
  | "bufferBeforeMin"
  | "bufferAfterMin"
  | "requirements"
  | "slotIntervalMin"
  | "minNotice"
  | "maxAdvanceDays"
  | "maxActivePerContact"
  | "minRescheduleNotice";

export function serviceErrors(
  f: ServiceForm,
  others: ReadonlyArray<{ _id: string; name: string }>,
  selfId?: string
): FormErrors<ServiceErrorKey> {
  const name = clean(f.name);
  let nameError: string | undefined;
  if (name.length < 1) nameError = "O nome é obrigatório.";
  else if (name.length > 60) nameError = "O nome pode ter no máximo 60 caracteres.";
  else if (others.some((o) => o._id !== selfId && nameKey(o.name) === nameKey(name))) nameError = `Já existe um serviço chamado "${name}". Escolha outro nome.`;

  const durationError = checkInt(f.durationMin, "A duração", 5, MAX_BLOCK_MIN, true);
  const beforeError = checkInt(f.bufferBeforeMin, "A folga antes", 0, 120);
  const afterError = checkInt(f.bufferAfterMin, "A folga depois", 0, 120);
  const before = parseIntField(f.bufferBeforeMin) ?? 0;
  const after = parseIntField(f.bufferAfterMin) ?? 0;
  const tooLong = (label: string, dur: number) =>
    dur + before + after > MAX_BLOCK_MIN ? `${label} somada às folgas passa de ${MAX_BLOCK_MIN} minutos (${MAX_BLOCK_MIN / 60} horas).` : undefined;

  let durationBlock = durationError;
  const d = parseIntField(f.durationMin);
  if (!durationBlock && d !== undefined && !beforeError && !afterError) durationBlock = tooLong("A duração", d);

  let variantsError: string | undefined;
  if (f.variants.length > MAX_VARIANTS) variantsError = `Um serviço aceita no máximo ${MAX_VARIANTS} variações.`;
  else {
    const names = new Set<string>();
    for (const v of f.variants) {
      const vname = clean(v.name);
      if (!vname) {
        variantsError = "Dê um nome a cada variação (por exemplo, Retorno).";
        break;
      }
      if (vname.length > 60) {
        variantsError = "O nome da variação pode ter no máximo 60 caracteres.";
        break;
      }
      if (names.has(nameKey(vname))) {
        variantsError = "As variações não podem repetir o nome.";
        break;
      }
      names.add(nameKey(vname));
      const e = checkInt(v.durationMin, `A duração de "${vname}"`, 5, MAX_BLOCK_MIN, true);
      if (e) {
        variantsError = e;
        break;
      }
      if (!beforeError && !afterError) {
        const long = tooLong(`A duração de "${vname}"`, Number(v.durationMin));
        if (long) {
          variantsError = long;
          break;
        }
      }
    }
  }

  let requirementsError: string | undefined;
  if (f.requirements.length < 1 || f.requirements.length > MAX_REQUIREMENTS) {
    requirementsError = `O serviço precisa de 1 a ${MAX_REQUIREMENTS} itens (por exemplo, uma sala e um profissional).`;
  } else {
    const roles = new Set<string>();
    for (const r of f.requirements) {
      const role = clean(r.role);
      if (!role) {
        requirementsError = "Dê um nome a cada item (por exemplo, Sala).";
        break;
      }
      if (role.length > 40) {
        requirementsError = "O nome do item pode ter no máximo 40 caracteres.";
        break;
      }
      if (roles.has(nameKey(role))) {
        requirementsError = "Os itens não podem repetir o nome.";
        break;
      }
      roles.add(nameKey(role));
      const e = checkInt(r.units, "As vagas que o serviço ocupa", 1, MAX_CAPACITY);
      if (e) {
        requirementsError = e;
        break;
      }
    }
  }

  return compact<ServiceErrorKey>({
    name: nameError,
    durationMin: durationBlock,
    variants: variantsError,
    bufferBeforeMin: beforeError,
    bufferAfterMin: afterError,
    requirements: requirementsError,
    slotIntervalMin: checkInt(f.slotIntervalMin, "O intervalo entre horários", 5, 240),
    minNotice: noticeError(f.minNotice, "A antecedência mínima"),
    maxAdvanceDays: checkInt(f.maxAdvanceDays, "A antecedência máxima", 1, 730),
    maxActivePerContact: checkInt(f.maxActivePerContact, "O máximo por cliente", 1, 50),
    minRescheduleNotice: noticeError(f.minRescheduleNotice, "A antecedência para remarcar"),
  });
}

type ServiceRequirementArg = {
  role: string;
  kind: ResourceKind;
  resourceIds?: Id<"schedResources">[];
  tag?: string;
  units?: number;
  exclusive?: boolean;
};

function requirementsArgs(reqs: RequirementForm[]): ServiceRequirementArg[] {
  return reqs.map((r) => ({
    role: clean(r.role),
    kind: r.kind,
    ...(r.resourceIds.length > 0 ? { resourceIds: r.resourceIds as Id<"schedResources">[] } : {}),
    ...(r.tag.trim() !== "" ? { tag: r.tag.trim() } : {}),
    ...(r.units.trim() !== "" ? { units: Number(r.units) } : {}),
    ...(r.exclusive ? { exclusive: true } : {}),
  }));
}
const variantsArgs = (vs: VariantForm[]) => withVariantKeys(vs).map((v) => ({ key: v.key, name: clean(v.name), durationMin: Number(v.durationMin) }));

export interface ServiceArgs {
  name?: string;
  durationMin?: number;
  variants?: Array<{ key: string; name: string; durationMin: number }> | null;
  bufferBeforeMin?: number | null;
  bufferAfterMin?: number | null;
  requirements?: ServiceRequirementArg[];
  slotIntervalMin?: number | null;
  minNoticeMin?: number | null;
  maxAdvanceDays?: number | null;
  maxActivePerContact?: number | null;
  clientCanCancel?: boolean | null;
  clientCanReschedule?: boolean | null;
  minRescheduleNoticeMin?: number | null;
  aiBookable?: boolean | null;
  publicBookable?: boolean | null;
}

const numOrNull = (raw: string): number | null => {
  const n = parseIntField(raw);
  return n === undefined ? null : n;
};

/**
 * Só o que mudou. Esvaziar um campo opcional manda `null` (volta ao padrão); marcar de volta o padrão de
 * um booleano manda `null` também (o servidor guarda "ausente", não `true`).
 */
export function servicePatchArgs(f: ServiceForm, saved: ServiceForm): ServiceArgs {
  const p: ServiceArgs = {};
  if (clean(f.name) !== clean(saved.name)) p.name = clean(f.name);
  if (f.durationMin.trim() !== saved.durationMin.trim()) p.durationMin = Number(f.durationMin);
  if (JSON.stringify(f.variants) !== JSON.stringify(saved.variants)) p.variants = f.variants.length > 0 ? variantsArgs(f.variants) : null;
  if (f.bufferBeforeMin.trim() !== saved.bufferBeforeMin.trim()) p.bufferBeforeMin = numOrNull(f.bufferBeforeMin);
  if (f.bufferAfterMin.trim() !== saved.bufferAfterMin.trim()) p.bufferAfterMin = numOrNull(f.bufferAfterMin);
  if (JSON.stringify(f.requirements) !== JSON.stringify(saved.requirements)) p.requirements = requirementsArgs(f.requirements);
  if (f.slotIntervalMin.trim() !== saved.slotIntervalMin.trim()) p.slotIntervalMin = numOrNull(f.slotIntervalMin);
  if (!sameNotice(f.minNotice, saved.minNotice)) p.minNoticeMin = noticeToMinutes(f.minNotice) ?? null;
  if (f.maxAdvanceDays.trim() !== saved.maxAdvanceDays.trim()) p.maxAdvanceDays = numOrNull(f.maxAdvanceDays);
  if (f.maxActivePerContact.trim() !== saved.maxActivePerContact.trim()) p.maxActivePerContact = numOrNull(f.maxActivePerContact);
  if (f.clientCanCancel !== saved.clientCanCancel) p.clientCanCancel = f.clientCanCancel ? null : false;
  if (f.clientCanReschedule !== saved.clientCanReschedule) p.clientCanReschedule = f.clientCanReschedule ? null : false;
  if (!sameNotice(f.minRescheduleNotice, saved.minRescheduleNotice)) p.minRescheduleNoticeMin = noticeToMinutes(f.minRescheduleNotice) ?? null;
  if (f.aiBookable !== saved.aiBookable) p.aiBookable = f.aiBookable ? null : false;
  if (f.publicBookable !== saved.publicBookable) p.publicBookable = f.publicBookable ? true : null;
  return p;
}

/** Criação: obrigatórios + o que foge do padrão (nada de `null` onde não há o que limpar). */
export function serviceCreateArgs(f: ServiceForm): ServiceArgs & { name: string; durationMin: number; requirements: ServiceRequirementArg[] } {
  const patch = servicePatchArgs(f, serviceFormFromEmpty());
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== null && v !== undefined) out[k] = v;
  return { ...out, name: clean(f.name), durationMin: Number(f.durationMin), requirements: requirementsArgs(f.requirements) };
}

/** Linha de base "sem nada marcado" (padrões do servidor) usada para montar a criação. */
function serviceFormFromEmpty(): ServiceForm {
  return { ...newServiceForm(), name: "", durationMin: "", requirements: [] };
}

/** "60 min", "1 h", "1 h 30 min" — para listas. */
export function durationLabel(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
