/**
 * Colunas do export CSV por entidade (F1 do plano de export/import).
 *
 * Puro (sem deps Convex): recebe o documento cru + mapas de desnormalização e
 * devolve a linha já legível. Regras:
 * - Datas em ISO 8601 (`toIsoDate`), listas como array (o `serializeCsv` junta
 *   com `;`, o mesmo separador que o `splitList` do import espera).
 * - Referências viram nome legível: `boardName`, `stageName`, `assignedToName`,
 *   `sourceName`, `contactName/Email/Phone`, `projectName`, `columnName`,
 *   `labels`, `assigneeEmails`.
 * - Custom fields achatados em colunas `cf_<key>` (o `suggestMapping` do import
 *   reconhece o prefixo `cf_`, então o CSV exportado volta a entrar no CRM).
 * - `columns` do job filtra o conjunto mantendo a ordem canônica.
 */

export type ExportEntity = "contacts" | "leads" | "tasks";

/** Subconjunto de `Doc<"fieldDefinitions">` usado aqui. */
export interface ExportFieldDef {
  key: string;
  name: string;
  type?: "text" | "number" | "boolean" | "date" | "select" | "multiselect";
  entityType?: "lead" | "contact" | null;
}

/** Documentos auxiliares indexados por id (só o que a linha precisa). */
export interface ExportLookups {
  contacts?: Map<string, any>;
  leads?: Map<string, any>;
  boards?: Map<string, any>;
  stages?: Map<string, any>;
  members?: Map<string, any>;
  sources?: Map<string, any>;
  projects?: Map<string, any>;
  columns?: Map<string, any>;
  labels?: Map<string, any>;
}

export const CUSTOM_COLUMN_PREFIX = "cf_";

const CONTACT_COLUMNS: string[] = [
  "id",
  "firstName",
  "lastName",
  "email",
  "phone",
  "whatsappNumber",
  "telegramUsername",
  "company",
  "title",
  "tags",
  "bio",
  "linkedinUrl",
  "instagramUrl",
  "facebookUrl",
  "twitterUrl",
  "city",
  "state",
  "country",
  "industry",
  "companySize",
  "cnpj",
  "companyWebsite",
  "preferredContactTime",
  "deviceType",
  "utmSource",
  "acquisitionChannel",
  "instagramFollowers",
  "linkedinConnections",
  "socialInfluenceScore",
  "aiOptOut",
  "createdAt",
  "updatedAt",
];

const LEAD_COLUMNS: string[] = [
  "id",
  "title",
  "contactName",
  "contactEmail",
  "contactPhone",
  "boardName",
  "stageName",
  "assignedToName",
  "assigneeEmail",
  "sourceName",
  "value",
  "currency",
  "priority",
  "temperature",
  "tags",
  "conversationStatus",
  "qualificationScore",
  "closedType",
  "closedReason",
  "closedAt",
  "archivedAt",
  "lastActivityAt",
  "createdAt",
  "updatedAt",
];

const TASK_COLUMNS: string[] = [
  "id",
  "title",
  "description",
  "type",
  "status",
  "priority",
  "activityType",
  "projectName",
  "columnName",
  "labels",
  "assigneeEmails",
  "assignedToName",
  "createdByName",
  "leadTitle",
  "contactName",
  "dueDate",
  "completedAt",
  "tags",
  "createdAt",
  "updatedAt",
];

const BASE_COLUMNS: Record<ExportEntity, string[]> = {
  contacts: CONTACT_COLUMNS,
  leads: LEAD_COLUMNS,
  tasks: TASK_COLUMNS,
};

/** Nome PT-BR da entidade (usado no nome do arquivo e nas descrições). */
export const ENTITY_LABELS: Record<ExportEntity, string> = {
  contacts: "contatos",
  leads: "leads",
  tasks: "tarefas",
};

/** epoch ms → ISO 8601 (vazio quando ausente/inválido). */
export function toIsoDate(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const date = new Date(value);
  return isNaN(date.getTime()) ? "" : date.toISOString();
}

/** Custom fields aplicáveis à entidade (sem `entityType` = vale para as duas). */
export function fieldDefsForEntity(
  fieldDefs: ExportFieldDef[] | undefined,
  entity: ExportEntity
): ExportFieldDef[] {
  if (entity === "tasks") return [];
  const wanted = entity === "contacts" ? "contact" : "lead";
  return (fieldDefs ?? []).filter(
    (def) => def.entityType === undefined || def.entityType === null || def.entityType === wanted
  );
}

/**
 * Colunas finais do CSV: base da entidade + `cf_<key>`, filtradas pelo
 * subconjunto pedido no job (ordem canônica preservada; pedido vazio ou sem
 * nenhuma coluna conhecida = tudo).
 */
export function buildExportColumns(
  entity: ExportEntity,
  fieldDefs: ExportFieldDef[] = [],
  requested?: string[] | null
): string[] {
  const all = [
    ...BASE_COLUMNS[entity],
    ...fieldDefsForEntity(fieldDefs, entity).map((def) => `${CUSTOM_COLUMN_PREFIX}${def.key}`),
  ];
  if (!requested || requested.length === 0) return all;
  const wanted = new Set(requested);
  const filtered = all.filter((column) => wanted.has(column));
  return filtered.length > 0 ? filtered : all;
}

function memberName(lookups: ExportLookups, id: unknown): string {
  if (typeof id !== "string") return "";
  return String(lookups.members?.get(id)?.name ?? "");
}

function memberEmail(lookups: ExportLookups, id: unknown): string {
  if (typeof id !== "string") return "";
  return String(lookups.members?.get(id)?.email ?? "");
}

function contactFullName(contact: any): string {
  if (!contact) return "";
  return `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim();
}

function customFieldValue(def: ExportFieldDef, raw: unknown): unknown {
  if (raw === undefined || raw === null) return "";
  if (def.type === "date") return toIsoDate(raw);
  return raw;
}

function buildContactRow(doc: any): Record<string, unknown> {
  return {
    id: doc._id,
    firstName: doc.firstName ?? "",
    lastName: doc.lastName ?? "",
    email: doc.email ?? "",
    phone: doc.phone ?? "",
    whatsappNumber: doc.whatsappNumber ?? "",
    telegramUsername: doc.telegramUsername ?? "",
    company: doc.company ?? "",
    title: doc.title ?? "",
    tags: doc.tags ?? [],
    bio: doc.bio ?? "",
    linkedinUrl: doc.linkedinUrl ?? "",
    instagramUrl: doc.instagramUrl ?? "",
    facebookUrl: doc.facebookUrl ?? "",
    twitterUrl: doc.twitterUrl ?? "",
    city: doc.city ?? "",
    state: doc.state ?? "",
    country: doc.country ?? "",
    industry: doc.industry ?? "",
    companySize: doc.companySize ?? "",
    cnpj: doc.cnpj ?? "",
    companyWebsite: doc.companyWebsite ?? "",
    preferredContactTime: doc.preferredContactTime ?? "",
    deviceType: doc.deviceType ?? "",
    utmSource: doc.utmSource ?? "",
    acquisitionChannel: doc.acquisitionChannel ?? "",
    instagramFollowers: doc.instagramFollowers ?? "",
    linkedinConnections: doc.linkedinConnections ?? "",
    socialInfluenceScore: doc.socialInfluenceScore ?? "",
    aiOptOut: doc.aiOptOut === true ? "true" : "false",
    createdAt: toIsoDate(doc.createdAt),
    updatedAt: toIsoDate(doc.updatedAt),
  };
}

function buildLeadRow(doc: any, lookups: ExportLookups): Record<string, unknown> {
  const contact = doc.contactId ? lookups.contacts?.get(doc.contactId) : undefined;
  return {
    id: doc._id,
    title: doc.title ?? "",
    contactName: contactFullName(contact),
    contactEmail: contact?.email ?? "",
    contactPhone: contact?.phone ?? "",
    boardName: lookups.boards?.get(doc.boardId)?.name ?? "",
    stageName: lookups.stages?.get(doc.stageId)?.name ?? "",
    assignedToName: memberName(lookups, doc.assignedTo),
    assigneeEmail: memberEmail(lookups, doc.assignedTo),
    sourceName: doc.sourceId ? (lookups.sources?.get(doc.sourceId)?.name ?? "") : "",
    value: doc.value ?? 0,
    currency: doc.currency ?? "",
    priority: doc.priority ?? "",
    temperature: doc.temperature ?? "",
    tags: doc.tags ?? [],
    conversationStatus: doc.conversationStatus ?? "",
    qualificationScore: doc.qualification?.score ?? "",
    closedType: doc.closedType ?? "",
    closedReason: doc.closedReason ?? "",
    closedAt: toIsoDate(doc.closedAt),
    archivedAt: toIsoDate(doc.archivedAt),
    lastActivityAt: toIsoDate(doc.lastActivityAt),
    createdAt: toIsoDate(doc.createdAt),
    updatedAt: toIsoDate(doc.updatedAt),
  };
}

function buildTaskRow(doc: any, lookups: ExportLookups): Record<string, unknown> {
  const assigneeIds: string[] =
    Array.isArray(doc.assigneeIds) && doc.assigneeIds.length > 0
      ? doc.assigneeIds
      : doc.assignedTo
        ? [doc.assignedTo]
        : [];
  const contact = doc.contactId ? lookups.contacts?.get(doc.contactId) : undefined;
  return {
    id: doc._id,
    title: doc.title ?? "",
    description: doc.description ?? "",
    type: doc.type ?? "",
    status: doc.status ?? "",
    priority: doc.priority ?? "",
    activityType: doc.activityType ?? "",
    projectName: doc.projectId ? (lookups.projects?.get(doc.projectId)?.name ?? "") : "",
    columnName: doc.columnId ? (lookups.columns?.get(doc.columnId)?.name ?? "") : "",
    labels: (doc.labelIds ?? [])
      .map((id: string) => lookups.labels?.get(id)?.name ?? "")
      .filter((name: string) => name !== ""),
    assigneeEmails: assigneeIds
      .map((id) => memberEmail(lookups, id))
      .filter((email) => email !== ""),
    assignedToName: memberName(lookups, doc.assignedTo ?? assigneeIds[0]),
    createdByName: memberName(lookups, doc.createdBy),
    leadTitle: doc.leadId ? (lookups.leads?.get(doc.leadId)?.title ?? "") : "",
    contactName: contactFullName(contact),
    dueDate: toIsoDate(doc.dueDate),
    completedAt: toIsoDate(doc.completedAt),
    tags: doc.tags ?? [],
    createdAt: toIsoDate(doc.createdAt),
    updatedAt: toIsoDate(doc.updatedAt),
  };
}

/**
 * Monta a linha completa (base + `cf_<key>`) de um documento.
 * Colunas ausentes na linha viram célula vazia no `serializeCsv`, então devolver
 * o conjunto completo e deixar o filtro de colunas para o serializador é seguro.
 */
export function buildExportRow(
  entity: ExportEntity,
  doc: any,
  lookups: ExportLookups = {},
  fieldDefs: ExportFieldDef[] = []
): Record<string, unknown> {
  const row =
    entity === "contacts"
      ? buildContactRow(doc)
      : entity === "leads"
        ? buildLeadRow(doc, lookups)
        : buildTaskRow(doc, lookups);

  for (const def of fieldDefsForEntity(fieldDefs, entity)) {
    row[`${CUSTOM_COLUMN_PREFIX}${def.key}`] = customFieldValue(def, doc.customFields?.[def.key]);
  }

  return row;
}
