/**
 * Agenda v2 — porta ÚNICA de escrita da configuração (A3a): serviços, recursos, `schedSettings` e
 * modelos prontos. As mutations de `schedulingConfig.ts` são finas e chamam estes cores; o REST/MCP/
 * Copiloto (outros PRs) devem chamar os mesmos cores.
 *
 * Regras que valem em TODA escrita (ConvexError em PT-BR, sem vazar existência entre orgs):
 *  - nomes únicos por org, sem acento/caixa (a IA cita pelo nome), entre ativos e arquivados;
 *  - teto de recursos/serviços por org conta TAMBÉM os arquivados (nunca se apaga; arquivar/reativar);
 *  - duração (de cada variação) + folgas ≤ MAX_BLOCK_MIN; capacidade inteira ≥ 1 (pessoa = 1);
 *  - `weekly` por `validateWeekly`, intervalos de exceção por `validateIntervals`;
 *  - requisito do serviço só aponta para recurso da MESMA org e do mesmo tipo;
 *  - recurso-pessoa ligado a membro passa por `assertAssignableMember`;
 *  - auditoria (`auditLogs`) com antes/depois, `entityType` em schedService/schedResource/schedSettings.
 *
 * Fuso: a agenda herda `organizations.settings.timezone`; NÃO há fuso em `schedSettings`. Trocar o fuso
 * da org com agendamentos futuros é RECUSADO (`assertTimezoneChangeAllowed`, ligado em
 * `organizations.updateOrganization`): `localDate` dos agendamentos e das exceções é denormalizado no
 * fuso antigo e os horários continuam em UTC, então a troca mudaria o dia/hora marcado de significado.
 * Reprocessar ficaria para uma op própria se o dono pedir.
 *
 * Esta lib NÃO lê a tabela de ocupação diretamente: usa `schedRead` (guard de build do A3b).
 */
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { assertAssignableMember, requireAccountWithEmail } from "./auth";
import { peakUnits, validateWeekly } from "./schedAvailability";
import {
  GRID_MINUTES_OPTIONS,
  MAX_BLOCK_MIN,
  MAX_RESOURCES_PER_ORG,
  MAX_SERVICES_PER_ORG,
} from "./schedConstants";
import { countFutureAppointmentsOfService, hasFutureActiveAppointment, listFutureAllocations } from "./schedRead";
import { type SchedTemplateDraft, isSchedTemplateKey } from "./schedTemplates";
import { smartMode as smartModeValidator } from "../schema";

export const resourceKindValidator = v.union(v.literal("person"), v.literal("room"), v.literal("equipment"));
const weeklyItem = v.object({ weekday: v.number(), startMin: v.number(), endMin: v.number() });

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

/** Chave de unicidade: sem acento, minúscula, espaços colapsados. */
export function nameKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function fail(message: string): never {
  throw new ConvexError(message);
}

function int(label: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${label} precisa ser um número inteiro entre ${min} e ${max}.`);
  }
  return value;
}

function optInt(label: string, value: number | undefined, min: number, max: number): number | undefined {
  return value === undefined ? undefined : int(label, value, min, max);
}

function cleanText(label: string, raw: string, max: number): string {
  const s = raw.replace(/\s+/g, " ").trim();
  if (s.length < 1) fail(`${label} é obrigatório.`);
  if (s.length > max) fail(`${label} pode ter no máximo ${max} caracteres.`);
  return s;
}

/** Retrato para auditoria: `_id` vira `id` (Convex recusa campo com `_`), `undefined` some. */
export function auditSnapshot(doc: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!doc) return {};
  const { _id, _creationTime, ...rest } = doc;
  void _creationTime;
  const out = JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
  if (_id !== undefined) out.id = _id;
  return out;
}

async function writeAudit(
  ctx: MutationCtx,
  a: {
    organizationId: Id<"organizations">;
    member: Doc<"teamMembers">;
    entityType: "schedService" | "schedResource" | "schedSettings";
    entityId: string;
    action: "create" | "update";
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    description: string;
    severity?: "low" | "medium" | "high";
    metadata?: Record<string, unknown>;
    now: number;
  }
): Promise<void> {
  await ctx.db.insert("auditLogs", {
    organizationId: a.organizationId,
    entityType: a.entityType,
    entityId: a.entityId,
    action: a.action,
    actorId: a.member._id,
    actorType: "human",
    changes: { before: a.before, after: a.after },
    metadata: a.metadata ? JSON.parse(JSON.stringify(a.metadata)) : undefined,
    description: a.description,
    severity: a.severity ?? "low",
    createdAt: a.now,
  });
}

// ---------------------------------------------------------------------------
// Fuso
// ---------------------------------------------------------------------------

/**
 * Trocar o fuso da org com agendamento ativo futuro é recusado (ver cabeçalho). Chamado por
 * `organizations.updateOrganization` só quando o fuso muda de fato.
 */
export async function assertTimezoneChangeAllowed(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  now: number
): Promise<void> {
  if (await hasFutureActiveAppointment(ctx, organizationId, now)) {
    fail(
      "Não é possível trocar o fuso horário enquanto houver agendamentos futuros na Agenda: os horários marcados mudariam de dia e hora. Cancele ou conclua esses agendamentos e tente de novo."
    );
  }
}

// ---------------------------------------------------------------------------
// Serviços
// ---------------------------------------------------------------------------

export const serviceInputFields = {
  name: v.string(),
  durationMin: v.number(),
  variants: v.optional(v.array(v.object({ key: v.string(), name: v.string(), durationMin: v.number() }))),
  bufferBeforeMin: v.optional(v.number()),
  bufferAfterMin: v.optional(v.number()),
  requirements: v.array(
    v.object({
      role: v.string(),
      kind: resourceKindValidator,
      resourceIds: v.optional(v.array(v.id("schedResources"))),
      tag: v.optional(v.string()),
      units: v.optional(v.number()),
      exclusive: v.optional(v.boolean()),
    })
  ),
  slotIntervalMin: v.optional(v.number()),
  minNoticeMin: v.optional(v.number()),
  maxAdvanceDays: v.optional(v.number()),
  maxActivePerContact: v.optional(v.number()),
  clientCanCancel: v.optional(v.boolean()),
  clientCanReschedule: v.optional(v.boolean()),
  minRescheduleNoticeMin: v.optional(v.number()),
  lateCancelWindowMin: v.optional(v.number()),
  smartMode: v.optional(smartModeValidator),
  aiBookable: v.optional(v.boolean()),
  publicBookable: v.optional(v.boolean()),
  priceCents: v.optional(v.number()),
  sortOrder: v.optional(v.number()),
};
export type ServiceInput = {
  name: string;
  durationMin: number;
  variants?: Array<{ key: string; name: string; durationMin: number }>;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  requirements: Array<{
    role: string;
    kind: "person" | "room" | "equipment";
    resourceIds?: Id<"schedResources">[];
    tag?: string;
    units?: number;
    exclusive?: boolean;
  }>;
  slotIntervalMin?: number;
  minNoticeMin?: number;
  maxAdvanceDays?: number;
  maxActivePerContact?: number;
  clientCanCancel?: boolean;
  clientCanReschedule?: boolean;
  minRescheduleNoticeMin?: number;
  lateCancelWindowMin?: number;
  smartMode?: "off" | "rank" | "restrict";
  aiBookable?: boolean;
  publicBookable?: boolean;
  priceCents?: number;
  sortOrder?: number;
};

type ServiceFields = Omit<Doc<"schedServices">, "_id" | "_creationTime" | "organizationId" | "active" | "createdAt" | "updatedAt">;

/** Valida e normaliza o formulário de serviço (sem leitura de banco). Substitui o documento por inteiro. */
export function normalizeServiceInput(input: ServiceInput): Omit<ServiceFields, "sortOrder" | "requirements"> & {
  sortOrder: number | undefined;
  requirements: ServiceInput["requirements"];
} {
  const name = cleanText("O nome do serviço", input.name, 60);
  const durationMin = int("A duração", input.durationMin, 5, MAX_BLOCK_MIN);
  const bufferBeforeMin = int("A folga antes", input.bufferBeforeMin ?? 0, 0, 120);
  const bufferAfterMin = int("A folga depois", input.bufferAfterMin ?? 0, 0, 120);
  const checkBlock = (label: string, dur: number) => {
    if (dur + bufferBeforeMin + bufferAfterMin > MAX_BLOCK_MIN) {
      fail(`${label} somada às folgas passa de ${MAX_BLOCK_MIN} minutos (${MAX_BLOCK_MIN / 60} horas).`);
    }
  };
  checkBlock("A duração", durationMin);

  let variants: ServiceInput["variants"];
  if (input.variants && input.variants.length > 0) {
    if (input.variants.length > 6) fail("Um serviço aceita no máximo 6 variações.");
    const keys = new Set<string>();
    const names = new Set<string>();
    variants = input.variants.map((vr) => {
      const key = vr.key.trim();
      if (!/^[a-z0-9_-]{1,20}$/.test(key)) fail("A chave da variação usa só letras minúsculas, números, - e _ (até 20).");
      if (keys.has(key)) fail("As variações não podem repetir a chave.");
      keys.add(key);
      const vname = cleanText("O nome da variação", vr.name, 60);
      if (names.has(nameKey(vname))) fail("As variações não podem repetir o nome.");
      names.add(nameKey(vname));
      const vdur = int(`A duração da variação "${vname}"`, vr.durationMin, 5, MAX_BLOCK_MIN);
      checkBlock(`A duração da variação "${vname}"`, vdur);
      return { key, name: vname, durationMin: vdur };
    });
  }

  if (input.requirements.length < 1 || input.requirements.length > 4) {
    fail("O serviço precisa de 1 a 4 requisitos (ex.: uma sala e um profissional).");
  }
  const roles = new Set<string>();
  const requirements = input.requirements.map((r) => {
    const role = cleanText("O nome do papel do requisito", r.role, 40);
    if (roles.has(nameKey(role))) fail("Os requisitos não podem repetir o papel.");
    roles.add(nameKey(role));
    const ids = r.resourceIds && r.resourceIds.length > 0 ? [...new Set(r.resourceIds)] : undefined;
    if (ids && ids.length > 20) fail("Um requisito aceita no máximo 20 recursos específicos.");
    const tag = r.tag === undefined || r.tag.trim() === "" ? undefined : cleanText("A etiqueta", r.tag, 30);
    const units = optInt("As unidades do requisito", r.units, 1, 50);
    return {
      role,
      kind: r.kind,
      ...(ids ? { resourceIds: ids } : {}),
      ...(tag ? { tag } : {}),
      ...(units !== undefined ? { units } : {}),
      ...(r.exclusive ? { exclusive: true } : {}),
    };
  });

  const slotIntervalMin = optInt("O passo dos horários", input.slotIntervalMin, 5, 240);
  const minNoticeMin = optInt("A antecedência mínima", input.minNoticeMin, 0, 43200);
  const maxAdvanceDays = optInt("A janela máxima", input.maxAdvanceDays, 1, 730);
  const maxActivePerContact = optInt("O teto por cliente", input.maxActivePerContact, 1, 50);
  const minRescheduleNoticeMin = optInt("A antecedência para remarcar", input.minRescheduleNoticeMin, 0, 43200);
  const lateCancelWindowMin = optInt("A janela de cancelamento tardio", input.lateCancelWindowMin, 0, 43200);
  const priceCents = optInt("O preço", input.priceCents, 0, 100_000_000);
  const sortOrder = optInt("A ordem", input.sortOrder, 0, 100_000);

  return {
    name,
    durationMin,
    ...(variants ? { variants } : {}),
    bufferBeforeMin,
    bufferAfterMin,
    requirements,
    ...(slotIntervalMin !== undefined ? { slotIntervalMin } : {}),
    ...(minNoticeMin !== undefined ? { minNoticeMin } : {}),
    ...(maxAdvanceDays !== undefined ? { maxAdvanceDays } : {}),
    ...(maxActivePerContact !== undefined ? { maxActivePerContact } : {}),
    ...(input.clientCanCancel !== undefined ? { clientCanCancel: input.clientCanCancel } : {}),
    ...(input.clientCanReschedule !== undefined ? { clientCanReschedule: input.clientCanReschedule } : {}),
    ...(minRescheduleNoticeMin !== undefined ? { minRescheduleNoticeMin } : {}),
    ...(lateCancelWindowMin !== undefined ? { lateCancelWindowMin } : {}),
    ...(input.smartMode !== undefined ? { smartMode: input.smartMode } : {}),
    ...(input.aiBookable !== undefined ? { aiBookable: input.aiBookable } : {}),
    ...(input.publicBookable !== undefined ? { publicBookable: input.publicBookable } : {}),
    ...(priceCents !== undefined ? { priceCents } : {}),
    sortOrder,
  };
}

async function loadServices(ctx: MutationCtx, organizationId: Id<"organizations">): Promise<Doc<"schedServices">[]> {
  return await ctx.db
    .query("schedServices")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(MAX_SERVICES_PER_ORG + 1);
}
async function loadResources(ctx: MutationCtx, organizationId: Id<"organizations">): Promise<Doc<"schedResources">[]> {
  return await ctx.db
    .query("schedResources")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(MAX_RESOURCES_PER_ORG + 1);
}

export async function upsertServiceCore(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    member: Doc<"teamMembers">;
    serviceId?: Id<"schedServices">;
    input: ServiceInput;
    now: number;
    /** O modelo grava uma auditoria só; as outras vias deixam `true`. */
    audit?: boolean;
  }
): Promise<Id<"schedServices">> {
  const { organizationId, member, now } = args;
  const fields = normalizeServiceInput(args.input);
  const all = await loadServices(ctx, organizationId);

  let existing: Doc<"schedServices"> | null = null;
  if (args.serviceId !== undefined) {
    existing = all.find((s) => s._id === args.serviceId) ?? null;
    if (!existing) fail("Serviço não encontrado.");
  } else if (all.length >= MAX_SERVICES_PER_ORG) {
    fail(
      `Esta organização já tem ${MAX_SERVICES_PER_ORG} serviços (contando os arquivados). Reative ou renomeie um existente em vez de criar outro.`
    );
  }
  if (all.some((s) => s._id !== existing?._id && nameKey(s.name) === nameKey(fields.name))) {
    fail(`Já existe um serviço chamado "${fields.name}". Escolha outro nome.`);
  }

  // Requisitos só apontam para recursos da MESMA org, do tipo certo e ativos (os já presentes ficam).
  const previousIds = new Set<string>(existing?.requirements.flatMap((r) => r.resourceIds ?? []) ?? []);
  for (const req of fields.requirements) {
    for (const id of req.resourceIds ?? []) {
      const res = await ctx.db.get(id);
      if (!res || res.organizationId !== organizationId) fail("Um dos recursos escolhidos não existe nesta organização.");
      if (res.kind !== req.kind) fail(`"${res.name}" não é do tipo exigido pelo papel "${req.role}".`);
      if (!res.active && !previousIds.has(id)) fail(`"${res.name}" está arquivado. Reative-o antes de usar no serviço.`);
    }
  }

  const sortOrder = fields.sortOrder ?? existing?.sortOrder ?? Math.max(-1, ...all.map((s) => s.sortOrder)) + 1;
  const doc = { ...fields, sortOrder };
  let id: Id<"schedServices">;
  if (existing) {
    // Substitui o formulário inteiro: campo opcional ausente é removido.
    await ctx.db.replace(existing._id, {
      organizationId,
      ...doc,
      active: existing.active,
      createdAt: existing.createdAt,
      updatedAt: now,
    });
    id = existing._id;
  } else {
    id = await ctx.db.insert("schedServices", { organizationId, ...doc, active: true, createdAt: now, updatedAt: now });
  }
  if (args.audit !== false) {
    const after = await ctx.db.get(id);
    await writeAudit(ctx, {
      organizationId,
      member,
      entityType: "schedService",
      entityId: id,
      action: existing ? "update" : "create",
      before: existing ? auditSnapshot(existing) : undefined,
      after: auditSnapshot(after),
      description: `${existing ? "Editou" : "Criou"} o serviço "${fields.name}" da Agenda`,
      now,
    });
  }
  return id;
}

export async function setServiceActiveCore(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    member: Doc<"teamMembers">;
    serviceId: Id<"schedServices">;
    active: boolean;
    acceptFuture?: boolean;
    now: number;
  }
): Promise<{ changed: boolean; futureAppointments: number; futureAppointmentsCapped: boolean }> {
  const service = await ctx.db.get(args.serviceId);
  if (!service || service.organizationId !== args.organizationId) fail("Serviço não encontrado.");
  let future = { count: 0, truncated: false };
  if (!args.active && service.active) {
    future = await countFutureAppointmentsOfService(ctx, args.organizationId, service._id, args.now);
    // Aviso + aceite, não bloqueio: sem aceite nada muda e a tela mostra a contagem.
    if (future.count > 0 && !args.acceptFuture) {
      return { changed: false, futureAppointments: future.count, futureAppointmentsCapped: future.truncated };
    }
  }
  if (service.active === args.active) {
    return { changed: false, futureAppointments: future.count, futureAppointmentsCapped: future.truncated };
  }
  await ctx.db.patch(service._id, { active: args.active, updatedAt: args.now });
  await writeAudit(ctx, {
    organizationId: args.organizationId,
    member: args.member,
    entityType: "schedService",
    entityId: service._id,
    action: "update",
    before: { active: service.active },
    after: { active: args.active },
    description: `${args.active ? "Reativou" : "Arquivou"} o serviço "${service.name}" da Agenda`,
    metadata: { futureAppointments: future.count, acceptFuture: args.acceptFuture === true },
    now: args.now,
  });
  return { changed: true, futureAppointments: future.count, futureAppointmentsCapped: future.truncated };
}

// ---------------------------------------------------------------------------
// Recursos
// ---------------------------------------------------------------------------

export const resourceInputFields = {
  kind: resourceKindValidator,
  name: v.string(),
  capacity: v.number(),
  teamMemberId: v.optional(v.id("teamMembers")),
  weekly: v.array(weeklyItem),
  tags: v.optional(v.array(v.string())),
  sortOrder: v.optional(v.number()),
};
export type ResourceInput = {
  kind: "person" | "room" | "equipment";
  name: string;
  capacity: number;
  teamMemberId?: Id<"teamMembers">;
  weekly: Array<{ weekday: number; startMin: number; endMin: number }>;
  tags?: string[];
  sortOrder?: number;
};

export function normalizeResourceInput(input: ResourceInput) {
  const name = cleanText("O nome", input.name, 60);
  const capacity = int("A capacidade", input.capacity, 1, 50);
  if (input.kind === "person" && capacity !== 1) fail("Um profissional atende uma pessoa por vez: a capacidade é 1.");
  if (input.kind !== "person" && input.teamMemberId !== undefined) {
    fail("Só um profissional pode ser ligado a um membro da equipe.");
  }
  const weeklyCheck = validateWeekly(input.weekly);
  if (!weeklyCheck.ok) fail(weeklyCheck.error);
  const weekly = [...input.weekly]
    .map((w) => ({ weekday: w.weekday, startMin: w.startMin, endMin: w.endMin }))
    .sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
  let tags: string[] | undefined;
  if (input.tags && input.tags.length > 0) {
    const cleaned = [...new Set(input.tags.map((t) => cleanText("A etiqueta", t, 30).toLowerCase()))];
    if (cleaned.length > 10) fail("Um recurso aceita no máximo 10 etiquetas.");
    tags = cleaned;
  }
  const sortOrder = optInt("A ordem", input.sortOrder, 0, 100_000);
  return { kind: input.kind, name, capacity, weekly, tags, sortOrder, teamMemberId: input.teamMemberId };
}

async function assertMemberNotLinked(
  ctx: MutationCtx,
  memberId: Id<"teamMembers">,
  exceptResourceId: Id<"schedResources"> | undefined
): Promise<void> {
  const linked = await ctx.db
    .query("schedResources")
    .withIndex("by_team_member", (q) => q.eq("teamMemberId", memberId))
    .take(10);
  const other = linked.find((r) => r._id !== exceptResourceId && r.active);
  if (other) fail(`Este membro já está ligado a "${other.name}". Cada pessoa da equipe tem um único profissional na Agenda.`);
}

export async function upsertResourceCore(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    member: Doc<"teamMembers">;
    resourceId?: Id<"schedResources">;
    input: ResourceInput;
    now: number;
    audit?: boolean;
  }
): Promise<Id<"schedResources">> {
  const { organizationId, member, now } = args;
  const f = normalizeResourceInput(args.input);
  const all = await loadResources(ctx, organizationId);

  let existing: Doc<"schedResources"> | null = null;
  if (args.resourceId !== undefined) {
    existing = all.find((r) => r._id === args.resourceId) ?? null;
    if (!existing) fail("Recurso não encontrado.");
    if (existing.kind !== f.kind) fail("O tipo do recurso não pode mudar depois de criado: crie outro e arquive este.");
  } else if (all.length >= MAX_RESOURCES_PER_ORG) {
    fail(
      `Esta organização já tem ${MAX_RESOURCES_PER_ORG} salas, profissionais e equipamentos (contando os arquivados). Reative ou renomeie um existente.`
    );
  }
  if (all.some((r) => r._id !== existing?._id && nameKey(r.name) === nameKey(f.name))) {
    fail(`Já existe um recurso chamado "${f.name}". Escolha outro nome.`);
  }
  if (f.teamMemberId !== undefined && f.teamMemberId !== existing?.teamMemberId) {
    await assertAssignableMember(ctx, organizationId, f.teamMemberId);
    await assertMemberNotLinked(ctx, f.teamMemberId, existing?._id);
  }
  // Reduzir a capacidade abaixo do que já está marcado furaria a ocupação.
  if (existing && f.capacity < existing.capacity) {
    const future = await listFutureAllocations(ctx, existing._id, now);
    if (future.rows.length > 0) {
      const end = Math.max(...future.rows.map((r) => r.coreEnd));
      const peak = peakUnits(future.rows, now, end, "core");
      if (peak > f.capacity) {
        fail(`Já há ${peak} atendimentos ao mesmo tempo marcados em "${existing.name}". Remarque ou cancele antes de reduzir a capacidade para ${f.capacity}.`);
      }
    }
  }

  const sortOrder = f.sortOrder ?? existing?.sortOrder ?? Math.max(-1, ...all.map((r) => r.sortOrder)) + 1;
  const doc = {
    organizationId,
    kind: f.kind,
    name: f.name,
    capacity: f.capacity,
    ...(f.teamMemberId !== undefined ? { teamMemberId: f.teamMemberId } : {}),
    weekly: f.weekly,
    ...(f.tags ? { tags: f.tags } : {}),
    sortOrder,
  };
  let id: Id<"schedResources">;
  if (existing) {
    await ctx.db.replace(existing._id, { ...doc, active: existing.active, createdAt: existing.createdAt, updatedAt: now });
    id = existing._id;
  } else {
    id = await ctx.db.insert("schedResources", { ...doc, active: true, createdAt: now, updatedAt: now });
  }
  if (args.audit !== false) {
    await writeAudit(ctx, {
      organizationId,
      member,
      entityType: "schedResource",
      entityId: id,
      action: existing ? "update" : "create",
      before: existing ? auditSnapshot(existing) : undefined,
      after: auditSnapshot(await ctx.db.get(id)),
      description: `${existing ? "Editou" : "Criou"} ${f.name} na Agenda`,
      now,
    });
  }
  return id;
}

export async function setResourceActiveCore(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    member: Doc<"teamMembers">;
    resourceId: Id<"schedResources">;
    active: boolean;
    acceptFuture?: boolean;
    now: number;
  }
): Promise<{ changed: boolean; futureAppointments: number; servicesAffected: string[] }> {
  const res = await ctx.db.get(args.resourceId);
  if (!res || res.organizationId !== args.organizationId) fail("Recurso não encontrado.");
  let futureAppointments = 0;
  let servicesAffected: string[] = [];
  if (!args.active && res.active) {
    const future = await listFutureAllocations(ctx, res._id, args.now);
    futureAppointments = new Set(future.rows.map((r) => r.appointmentId)).size;
    const services = await loadServices(ctx, args.organizationId);
    servicesAffected = services
      .filter(
        (s) =>
          s.active &&
          s.requirements.some((r) => r.resourceIds && r.resourceIds.length > 0 && r.resourceIds.every((id) => id === res._id))
      )
      .map((s) => s.name)
      .slice(0, 10);
    if (futureAppointments > 0 && !args.acceptFuture) {
      return { changed: false, futureAppointments, servicesAffected };
    }
  }
  if (args.active && !res.active && res.teamMemberId !== undefined) {
    await assertMemberNotLinked(ctx, res.teamMemberId, res._id);
  }
  if (res.active === args.active) return { changed: false, futureAppointments, servicesAffected };
  await ctx.db.patch(res._id, { active: args.active, updatedAt: args.now });
  await writeAudit(ctx, {
    organizationId: args.organizationId,
    member: args.member,
    entityType: "schedResource",
    entityId: res._id,
    action: "update",
    before: { active: res.active },
    after: { active: args.active },
    description: `${args.active ? "Reativou" : "Arquivou"} ${res.name} na Agenda`,
    metadata: { futureAppointments, acceptFuture: args.acceptFuture === true },
    now: args.now,
  });
  return { changed: true, futureAppointments, servicesAffected };
}

// ---------------------------------------------------------------------------
// Configurações (`schedSettings`)
// ---------------------------------------------------------------------------

const weightsValidator = v.object({
  adjacency: v.number(),
  deadGap: v.number(),
  openNewResource: v.number(),
  earlyFirst: v.number(),
  balance: v.number(),
  preference: v.number(),
});
const nullable = <T extends ReturnType<typeof v.id> | ReturnType<typeof v.number>>(x: T) => v.optional(v.union(x, v.null()));
const aiLevel = v.union(v.literal("off"), v.literal("propose"), v.literal("auto"));

/** Patch parcial por grupo; `null` limpa o campo (volta ao padrão). */
export const settingsPatchValidator = v.object({
  gridMinutes: v.optional(v.number()),
  minNoticeMin: v.optional(v.number()),
  maxAdvanceDays: v.optional(v.number()),
  smart: v.optional(
    v.object({
      mode: v.optional(smartModeValidator),
      weights: v.optional(v.union(weightsValidator, v.null())),
      minUsefulGapMin: nullable(v.number()),
      minOffer: v.optional(v.number()),
    })
  ),
  ai: v.optional(
    v.object({
      consult: v.optional(v.boolean()),
      book: v.optional(aiLevel),
      reschedule: v.optional(aiLevel),
      cancel: v.optional(v.union(v.literal("handoff"), v.literal("auto"))),
      firstVisitNeedsApproval: v.optional(v.boolean()),
      maxAiBookingsPerContactPerDay: v.optional(v.number()),
    })
  ),
  humanConfirm: v.optional(
    v.object({
      mode: v.optional(v.union(v.literal("auto"), v.literal("suggest"), v.literal("off"))),
      defaultServiceId: nullable(v.id("schedServices")),
    })
  ),
  funnel: v.optional(
    v.object({
      onScheduledStageId: nullable(v.id("stages")),
      onCompletedStageId: nullable(v.id("stages")),
      onNoShowStageId: nullable(v.id("stages")),
    })
  ),
});
export type SettingsPatch = {
  gridMinutes?: number;
  minNoticeMin?: number;
  maxAdvanceDays?: number;
  smart?: {
    mode?: "off" | "rank" | "restrict";
    weights?: { adjacency: number; deadGap: number; openNewResource: number; earlyFirst: number; balance: number; preference: number } | null;
    minUsefulGapMin?: number | null;
    minOffer?: number;
  };
  ai?: {
    consult?: boolean;
    book?: "off" | "propose" | "auto";
    reschedule?: "off" | "propose" | "auto";
    cancel?: "handoff" | "auto";
    firstVisitNeedsApproval?: boolean;
    maxAiBookingsPerContactPerDay?: number;
  };
  humanConfirm?: { mode?: "auto" | "suggest" | "off"; defaultServiceId?: Id<"schedServices"> | null };
  funnel?: {
    onScheduledStageId?: Id<"stages"> | null;
    onCompletedStageId?: Id<"stages"> | null;
    onNoShowStageId?: Id<"stages"> | null;
  };
};

type Group = Record<string, unknown>;
/** Aplica `patch` sobre `base`: `undefined` ignora, `null` remove, resto grava. */
function mergeGroup(base: Group | undefined, patch: Group | undefined): Group | undefined {
  if (patch === undefined) return base;
  const out: Group = { ...(base ?? {}) };
  for (const [k, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    if (val === null) delete out[k];
    else out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function updateSchedSettingsCore(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    member: Doc<"teamMembers">;
    patch: SettingsPatch;
    /** `true` registra o aceite do "marca sozinha"; `false` revoga (e rebaixa o que estava em "auto"). */
    acks?: { aiAuto?: boolean };
    templateKey?: string;
    via?: "settings" | "onboarding" | "copilot";
    now: number;
  }
): Promise<void> {
  const { organizationId, member, patch, now } = args;
  const doc = await ctx.db
    .query("schedSettings")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .first();

  if (patch.gridMinutes !== undefined && !(GRID_MINUTES_OPTIONS as readonly number[]).includes(patch.gridMinutes)) {
    fail(`O passo da grade precisa ser um destes: ${GRID_MINUTES_OPTIONS.join(", ")} minutos.`);
  }
  optInt("A antecedência mínima", patch.minNoticeMin, 0, 43200);
  optInt("A janela máxima", patch.maxAdvanceDays, 1, 730);
  const s = patch.smart;
  if (s) {
    if (s.weights) {
      for (const [k, w] of Object.entries(s.weights)) {
        if (!Number.isFinite(w) || w < 0 || w > 1000) fail(`O peso "${k}" precisa estar entre 0 e 1000.`);
      }
    }
    if (s.minUsefulGapMin !== undefined && s.minUsefulGapMin !== null) int("A lacuna mínima útil", s.minUsefulGapMin, 0, 480);
    optInt("O mínimo de ofertas", s.minOffer, 1, 10);
  }
  optInt("O limite de marcações da IA por dia", patch.ai?.maxAiBookingsPerContactPerDay, 1, 50);

  const dsId = patch.humanConfirm?.defaultServiceId;
  if (dsId) {
    const svc = await ctx.db.get(dsId);
    if (!svc || svc.organizationId !== organizationId) fail("O serviço padrão não existe nesta organização.");
    if (!svc.active) fail("O serviço padrão está arquivado.");
  }
  for (const key of ["onScheduledStageId", "onCompletedStageId", "onNoShowStageId"] as const) {
    const stageId = patch.funnel?.[key];
    if (!stageId) continue;
    const stage = await ctx.db.get(stageId);
    if (!stage || stage.organizationId !== organizationId) fail("Uma das etapas do funil não existe nesta organização.");
    if (stage.isClosedLost) fail("A agenda não move leads para etapa de perda (ela exige motivo).");
  }

  // Política da IA: "auto" só vale com o aceite auditado.
  const wantsAuto = patch.ai?.book === "auto" || patch.ai?.reschedule === "auto" || patch.ai?.cancel === "auto";
  let autoAck = doc?.ai?.autoAck;
  let ackChange: "granted" | "revoked" | null = null;
  if (args.acks?.aiAuto === true) {
    await requireAccountWithEmail(ctx);
    if (!autoAck) {
      autoAck = { by: member._id, at: now };
      ackChange = "granted";
    }
  } else if (args.acks?.aiAuto === false) {
    if (wantsAuto) fail("Não dá para ligar o 'marca sozinha' e revogar o aceite ao mesmo tempo.");
    if (autoAck) {
      autoAck = undefined;
      ackChange = "revoked";
    }
  }
  if (wantsAuto && !autoAck) {
    fail("Para a IA marcar, remarcar ou cancelar sozinha é preciso confirmar o aviso (aceite) de que ela passa a agir sem a sua aprovação.");
  }

  const before: Group = {
    gridMinutes: doc?.gridMinutes,
    minNoticeMin: doc?.minNoticeMin,
    maxAdvanceDays: doc?.maxAdvanceDays,
    smart: doc?.smart,
    ai: doc?.ai,
    humanConfirm: doc?.humanConfirm,
    funnel: doc?.funnel,
    templateKey: doc?.templateKey,
  };
  let ai = mergeGroup(doc?.ai as Group | undefined, patch.ai as Group | undefined);
  if (ackChange) {
    ai = { ...(ai ?? {}) };
    if (autoAck) ai.autoAck = autoAck;
    else {
      delete ai.autoAck;
      if (ai.book === "auto") ai.book = "propose";
      if (ai.reschedule === "auto") ai.reschedule = "propose";
      if (ai.cancel === "auto") ai.cancel = "handoff";
    }
    if (Object.keys(ai).length === 0) ai = undefined;
  }
  const next: Group = {
    gridMinutes: patch.gridMinutes ?? doc?.gridMinutes,
    minNoticeMin: patch.minNoticeMin ?? doc?.minNoticeMin,
    maxAdvanceDays: patch.maxAdvanceDays ?? doc?.maxAdvanceDays,
    smart: mergeGroup(doc?.smart as Group | undefined, patch.smart as Group | undefined),
    ai,
    humanConfirm: mergeGroup(doc?.humanConfirm as Group | undefined, patch.humanConfirm as Group | undefined),
    funnel: mergeGroup(doc?.funnel as Group | undefined, patch.funnel as Group | undefined),
    templateKey: args.templateKey ?? doc?.templateKey,
  };
  const changed = Object.keys(next).filter((k) => JSON.stringify(next[k] ?? null) !== JSON.stringify(before[k] ?? null));
  if (changed.length === 0 && doc) return;

  const fields = {
    gridMinutes: next.gridMinutes as number | undefined,
    minNoticeMin: next.minNoticeMin as number | undefined,
    maxAdvanceDays: next.maxAdvanceDays as number | undefined,
    smart: next.smart as Doc<"schedSettings">["smart"],
    ai: next.ai as Doc<"schedSettings">["ai"],
    humanConfirm: next.humanConfirm as Doc<"schedSettings">["humanConfirm"],
    funnel: next.funnel as Doc<"schedSettings">["funnel"],
    templateKey: next.templateKey as string | undefined,
    updatedBy: member._id,
    updatedAt: now,
  };
  let id: Id<"schedSettings">;
  if (doc) {
    await ctx.db.replace(doc._id, { organizationId, reminders: doc.reminders, ...fields });
    id = doc._id;
  } else {
    id = await ctx.db.insert("schedSettings", { organizationId, ...fields });
  }
  const pick = (g: Group) => auditSnapshot(Object.fromEntries(changed.map((k) => [k, g[k]])));
  await writeAudit(ctx, {
    organizationId,
    member,
    entityType: "schedSettings",
    entityId: id,
    action: doc ? "update" : "create",
    before: pick(before),
    after: pick(next),
    description: "Alterou as configurações da Agenda",
    metadata: { via: args.via ?? "settings", fields: changed },
    now,
  });
  if (ackChange) {
    await writeAudit(ctx, {
      organizationId,
      member,
      entityType: "schedSettings",
      entityId: id,
      action: "update",
      description:
        ackChange === "granted"
          ? "Aceitou que a IA marque horários sozinha, sem passar pela aprovação"
          : "Revogou o aceite do 'marca sozinha' da IA na Agenda",
      severity: "high",
      metadata: { ack: ackChange },
      now,
    });
  }
}

// ---------------------------------------------------------------------------
// Modelos prontos
// ---------------------------------------------------------------------------

export const templateDraftValidator = v.object({
  templateKey: v.string(),
  settings: v.object({
    gridMinutes: v.number(),
    smartMode: v.optional(smartModeValidator),
    minNoticeMin: v.optional(v.number()),
  }),
  resources: v.array(
    v.object({
      ref: v.string(),
      kind: resourceKindValidator,
      name: v.string(),
      capacity: v.number(),
      teamMemberId: v.optional(v.id("teamMembers")),
      weekly: v.array(weeklyItem),
      tags: v.optional(v.array(v.string())),
    })
  ),
  services: v.array(
    v.object({
      name: v.string(),
      durationMin: v.number(),
      bufferBeforeMin: v.number(),
      bufferAfterMin: v.number(),
      slotIntervalMin: v.optional(v.number()),
      aiBookable: v.optional(v.boolean()),
      requirements: v.array(
        v.object({
          role: v.string(),
          kind: resourceKindValidator,
          resourceRefs: v.optional(v.array(v.string())),
          tag: v.optional(v.string()),
          units: v.optional(v.number()),
          exclusive: v.optional(v.boolean()),
        })
      ),
    })
  ),
});

/**
 * Aplica o modelo: uma mutation, tudo ou nada (qualquer erro desfaz). Idempotente: se esta org já
 * aplicou o MESMO modelo, devolve `applied:false` sem tocar em nada; outro modelo, ou uma agenda que
 * já tem serviço/recurso, é recusado (nunca duplica nem mistura).
 */
export async function applySchedTemplateCore(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    member: Doc<"teamMembers">;
    templateKey: string;
    draft: SchedTemplateDraft;
    now: number;
  }
): Promise<{ applied: boolean; resourceIds: Id<"schedResources">[]; serviceIds: Id<"schedServices">[] }> {
  const { organizationId, member, draft, now } = args;
  if (!isSchedTemplateKey(args.templateKey) || draft.templateKey !== args.templateKey) fail("Modelo desconhecido.");
  const settingsDoc = await ctx.db
    .query("schedSettings")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .first();
  if (settingsDoc?.templateKey === args.templateKey) return { applied: false, resourceIds: [], serviceIds: [] };

  const anyService = await ctx.db.query("schedServices").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).first();
  const anyResource = await ctx.db.query("schedResources").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).first();
  if (anyService || anyResource) {
    fail("O modelo só pode ser aplicado numa agenda vazia, sem serviços nem salas e profissionais.");
  }
  if (draft.resources.length > MAX_RESOURCES_PER_ORG || draft.services.length > MAX_SERVICES_PER_ORG) {
    fail("O modelo passa do limite de serviços ou recursos.");
  }
  if (draft.services.length === 0) fail("O modelo precisa de ao menos um serviço.");
  const refs = new Set<string>();
  for (const r of draft.resources) {
    if (refs.has(r.ref)) fail("O modelo repete a referência de um recurso.");
    refs.add(r.ref);
  }

  const idByRef = new Map<string, Id<"schedResources">>();
  const resourceIds: Id<"schedResources">[] = [];
  for (const [i, r] of draft.resources.entries()) {
    const id = await upsertResourceCore(ctx, {
      organizationId,
      member,
      input: {
        kind: r.kind,
        name: r.name,
        capacity: r.capacity,
        teamMemberId: r.teamMemberId as Id<"teamMembers"> | undefined,
        weekly: r.weekly,
        tags: r.tags,
        sortOrder: i,
      },
      now,
      audit: false,
    });
    idByRef.set(r.ref, id);
    resourceIds.push(id);
  }
  const serviceIds: Id<"schedServices">[] = [];
  for (const [i, s] of draft.services.entries()) {
    const id = await upsertServiceCore(ctx, {
      organizationId,
      member,
      input: {
        name: s.name,
        durationMin: s.durationMin,
        bufferBeforeMin: s.bufferBeforeMin,
        bufferAfterMin: s.bufferAfterMin,
        slotIntervalMin: s.slotIntervalMin,
        aiBookable: s.aiBookable,
        sortOrder: i,
        requirements: s.requirements.map((req) => ({
          role: req.role,
          kind: req.kind,
          resourceIds: req.resourceRefs?.map((ref) => {
            const rid = idByRef.get(ref);
            if (!rid) fail("O modelo aponta para um recurso que não existe.");
            return rid;
          }),
          tag: req.tag,
          units: req.units,
          exclusive: req.exclusive,
        })),
      },
      now,
      audit: false,
    });
    serviceIds.push(id);
  }
  await updateSchedSettingsCore(ctx, {
    organizationId,
    member,
    patch: {
      gridMinutes: draft.settings.gridMinutes,
      minNoticeMin: draft.settings.minNoticeMin,
      smart: draft.settings.smartMode ? { mode: draft.settings.smartMode } : undefined,
    },
    templateKey: args.templateKey,
    via: "onboarding",
    now,
  });
  await writeAudit(ctx, {
    organizationId,
    member,
    entityType: "schedSettings",
    entityId: String(organizationId),
    action: "create",
    after: { templateKey: args.templateKey, resources: draft.resources.map((r) => r.name), services: draft.services.map((s) => s.name) },
    description: `Aplicou o modelo "${args.templateKey}" na Agenda (${resourceIds.length} recursos, ${serviceIds.length} serviços)`,
    metadata: { templateKey: args.templateKey, resourceIds, serviceIds },
    now,
  });
  return { applied: true, resourceIds, serviceIds };
}

