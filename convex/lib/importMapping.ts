/**
 * Mapeamento e coerção de linhas de CSV para contatos/leads (puro, sem deps
 * Convex e sem deps npm). Usado pelo wizard de importação:
 *   parseCsv → suggestMapping (sugestão automática header→campo)
 *            → coerceAndValidateRow (dry-run e execução)
 *
 * Convenções do `mapping`: `header → nome do campo | "cf:<key>" | "__ignore__"`.
 * Custom fields são validados contra as `fieldDefinitions` da org (tipo E
 * opções), no mesmo espírito do executor do atendente (`convex/attendant.ts`).
 */

export type ImportEntity = "contacts" | "leads";

export const IGNORE_FIELD = "__ignore__";
export const CUSTOM_FIELD_PREFIX = "cf:";

/** Subconjunto de `Doc<"fieldDefinitions">` que este módulo precisa. */
export interface ImportFieldDef {
  key: string;
  name: string;
  type: "text" | "number" | "boolean" | "date" | "select" | "multiselect";
  options?: string[] | null;
  entityType?: "lead" | "contact" | null;
  isRequired?: boolean;
}

/** header → campo | "cf:<key>" | "__ignore__" */
export type ImportMapping = Record<string, string>;

export interface RowError {
  field?: string;
  message: string;
}

export type CoerceResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: RowError[] };

type TargetType =
  | "string"
  | "email"
  | "phone"
  | "number"
  | "boolean"
  | "date"
  | "tags"
  | "enum";

interface TargetDef {
  field: string;
  /** Rótulo PT-BR para a UI de mapeamento. */
  label: string;
  type: TargetType;
  aliases: string[];
  /** Para `type: "enum"`: alias normalizado → valor canônico. */
  enumValues?: Record<string, string>;
  /** Rejeita números negativos (ex.: valor do negócio). */
  nonNegative?: boolean;
}

// ===== Normalização =====

/** minúsculas, sem acentos, sem pontuação, espaços colapsados. */
export function normalizeLabel(raw: string): string {
  return String(raw ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    // "e-mail" e "email" caem no mesmo token (vale p/ header E alias).
    .replace(/\be mail\b/g, "email");
}

/** Telefone só com dígitos (formato dos números vindos do WhatsApp). */
export function normalizePhone(raw: string): string {
  return String(raw ?? "").replace(/\D+/g, "");
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

/** Números pt-BR e en-US: "R$ 1.234,56" → 1234.56 · "1,5" → 1.5 · "2.500" → 2500 */
export function parseNumberValue(raw: string): number | null {
  let text = String(raw ?? "").trim();
  if (text === "") return null;
  const negative = /^\(.*\)$/.test(text) || text.startsWith("-");
  text = text.replace(/[()]/g, "");
  // Remove símbolos de moeda / espaços / sinal
  text = text.replace(/[^\d.,-]/g, "").replace(/-/g, "");
  if (text === "") return null;

  const hasDot = text.includes(".");
  const hasComma = text.includes(",");
  let normalized: string;
  if (hasDot && hasComma) {
    // O separador decimal é o último que aparece.
    normalized =
      text.lastIndexOf(",") > text.lastIndexOf(".")
        ? text.replace(/\./g, "").replace(",", ".")
        : text.replace(/,/g, "");
  } else if (hasComma) {
    // Vírgula sozinha: decimal (pt-BR), salvo grupos de milhar (1,234,567).
    normalized = /^\d{1,3}(,\d{3}){2,}$/.test(text)
      ? text.replace(/,/g, "")
      : text.replace(",", ".");
  } else if (hasDot) {
    // Ponto sozinho: decimal, salvo grupos de milhar (1.234 / 1.234.567).
    normalized = /^\d{1,3}(\.\d{3})+$/.test(text) ? text.replace(/\./g, "") : text;
  } else {
    normalized = text;
  }

  const parsed = Number(normalized);
  if (!isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

const TRUE_WORDS = new Set(["sim", "s", "true", "verdadeiro", "yes", "y", "1", "x", "ok"]);
const FALSE_WORDS = new Set(["nao", "n", "false", "falso", "no", "0", ""]);

/** "sim/não/true/false/1/0" → boolean (null = não reconhecido). */
export function parseBooleanValue(raw: string): boolean | null {
  const text = normalizeLabel(raw).replace(/\s+/g, "");
  if (TRUE_WORDS.has(text)) return true;
  if (FALSE_WORDS.has(text)) return false;
  return null;
}

/** ISO (`aaaa-mm-dd`, ISO completo) + `dd/mm/aaaa` (`-` e `.` também) → epoch ms. */
export function parseDateValue(raw: string): number | null {
  const text = String(raw ?? "").trim();
  if (text === "") return null;

  // dd/mm/aaaa [hh:mm[:ss]]
  const br = text.match(
    /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (br) {
    const day = Number(br[1]);
    const month = Number(br[2]);
    let year = Number(br[3]);
    if (br[3].length === 2) year += year < 70 ? 2000 : 1900;
    const hour = br[4] ? Number(br[4]) : 0;
    const minute = br[5] ? Number(br[5]) : 0;
    const second = br[6] ? Number(br[6]) : 0;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;
    const ms = Date.UTC(year, month - 1, day, hour, minute, second);
    const check = new Date(ms);
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
      return null; // 31/02/2026 e afins
    }
    return ms;
  }

  // aaaa-mm-dd ou ISO completo
  if (/^\d{4}-\d{2}-\d{2}([T\s].*)?$/.test(text)) {
    const iso = text.includes(" ") && !text.includes("T") ? text.replace(" ", "T") : text;
    const ms = Date.parse(iso);
    return isNaN(ms) ? null : ms;
  }

  // Epoch em ms já numérico
  if (/^\d{10,}$/.test(text)) return Number(text);

  return null;
}

/** Lista separada por `;` (mesmo separador usado no export). */
export function splitList(raw: string): string[] {
  return String(raw ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

// ===== Catálogos de campos =====

const PRIORITY_VALUES: Record<string, string> = {
  baixa: "low",
  baixo: "low",
  low: "low",
  media: "medium",
  medio: "medium",
  normal: "medium",
  medium: "medium",
  alta: "high",
  alto: "high",
  high: "high",
  urgente: "urgent",
  urgent: "urgent",
  critica: "urgent",
};

const TEMPERATURE_VALUES: Record<string, string> = {
  frio: "cold",
  fria: "cold",
  cold: "cold",
  morno: "warm",
  morna: "warm",
  warm: "warm",
  quente: "hot",
  hot: "hot",
};

const CONTACT_TARGETS: TargetDef[] = [
  {
    field: "firstName",
    label: "Nome",
    type: "string",
    aliases: ["nome", "primeiro nome", "first name", "firstname", "given name", "nome do contato"],
  },
  {
    field: "lastName",
    label: "Sobrenome",
    type: "string",
    aliases: ["sobrenome", "ultimo nome", "last name", "lastname", "surname", "family name"],
  },
  {
    field: "fullName",
    label: "Nome completo (divide em nome/sobrenome)",
    type: "string",
    aliases: ["nome completo", "full name", "fullname", "name", "nome e sobrenome", "contato"],
  },
  {
    field: "email",
    label: "E-mail",
    type: "email",
    aliases: ["email", "e mail", "e mail principal", "email principal", "correio eletronico", "email address", "endereco de email"],
  },
  {
    field: "phone",
    label: "Telefone",
    type: "phone",
    aliases: ["telefone", "celular", "whatsapp", "fone", "tel", "phone", "mobile", "cellphone", "phone number", "telefone celular", "numero de telefone", "numero"],
  },
  {
    field: "whatsappNumber",
    label: "Número de WhatsApp",
    type: "phone",
    aliases: ["whatsapp", "numero whatsapp", "whatsapp number", "numero do whatsapp", "wa"],
  },
  {
    field: "company",
    label: "Empresa",
    type: "string",
    aliases: ["empresa", "company", "organizacao", "organization", "razao social", "empresa cliente"],
  },
  {
    field: "title",
    label: "Cargo",
    type: "string",
    aliases: ["cargo", "funcao", "job title", "position", "role", "titulo do cargo"],
  },
  {
    field: "telegramUsername",
    label: "Telegram",
    type: "string",
    aliases: ["telegram", "usuario telegram", "telegram username"],
  },
  {
    field: "tags",
    label: "Etiquetas",
    type: "tags",
    aliases: ["etiquetas", "tags", "marcadores", "rotulos", "labels"],
  },
  {
    field: "bio",
    label: "Bio / observações",
    type: "string",
    aliases: ["bio", "biografia", "observacoes", "anotacoes", "notas", "notes", "descricao", "description"],
  },
  {
    field: "linkedinUrl",
    label: "LinkedIn",
    type: "string",
    aliases: ["linkedin", "linkedin url", "perfil linkedin"],
  },
  {
    field: "instagramUrl",
    label: "Instagram",
    type: "string",
    aliases: ["instagram", "insta", "instagram url", "perfil instagram"],
  },
  {
    field: "facebookUrl",
    label: "Facebook",
    type: "string",
    aliases: ["facebook", "fb", "facebook url"],
  },
  {
    field: "twitterUrl",
    label: "Twitter / X",
    type: "string",
    aliases: ["twitter", "twitter url", "x url", "perfil twitter"],
  },
  { field: "city", label: "Cidade", type: "string", aliases: ["cidade", "city", "municipio", "localidade"] },
  { field: "state", label: "Estado", type: "string", aliases: ["estado", "state", "uf", "provincia"] },
  { field: "country", label: "País", type: "string", aliases: ["pais", "country", "nacao"] },
  {
    field: "industry",
    label: "Setor",
    type: "string",
    aliases: ["setor", "industria", "segmento", "industry", "ramo", "area de atuacao"],
  },
  {
    field: "companySize",
    label: "Porte da empresa",
    type: "string",
    aliases: ["porte", "tamanho da empresa", "company size", "numero de funcionarios", "funcionarios", "employees"],
  },
  { field: "cnpj", label: "CNPJ", type: "string", aliases: ["cnpj", "cpf cnpj", "documento", "tax id"] },
  {
    field: "companyWebsite",
    label: "Site",
    type: "string",
    aliases: ["site", "website", "web site", "url", "site da empresa", "pagina"],
  },
  {
    field: "preferredContactTime",
    label: "Melhor horário de contato",
    type: "enum",
    aliases: ["melhor horario", "horario preferido", "periodo de contato", "preferred contact time"],
    enumValues: {
      manha: "morning",
      morning: "morning",
      tarde: "afternoon",
      afternoon: "afternoon",
      noite: "evening",
      evening: "evening",
    },
  },
  {
    field: "deviceType",
    label: "Dispositivo",
    type: "enum",
    aliases: ["dispositivo", "device", "tipo de dispositivo", "aparelho", "device type"],
    enumValues: {
      android: "android",
      iphone: "iphone",
      ios: "iphone",
      apple: "iphone",
      desktop: "desktop",
      computador: "desktop",
      pc: "desktop",
      desconhecido: "unknown",
      unknown: "unknown",
    },
  },
  {
    field: "utmSource",
    label: "UTM source",
    type: "string",
    aliases: ["utm source", "utm", "utm origem"],
  },
  {
    field: "acquisitionChannel",
    label: "Canal de aquisição",
    type: "string",
    aliases: ["canal de aquisicao", "canal", "acquisition channel", "origem", "fonte", "source"],
  },
  {
    field: "instagramFollowers",
    label: "Seguidores no Instagram",
    type: "number",
    aliases: ["seguidores instagram", "instagram followers", "seguidores"],
  },
  {
    field: "linkedinConnections",
    label: "Conexões no LinkedIn",
    type: "number",
    aliases: ["conexoes linkedin", "linkedin connections", "conexoes"],
  },
  {
    field: "socialInfluenceScore",
    label: "Score de influência",
    type: "number",
    aliases: ["score de influencia", "social influence score", "influencia", "score social"],
  },
  {
    field: "aiOptOut",
    label: "Opt-out de IA",
    type: "boolean",
    aliases: ["opt out de ia", "opt out ia", "sem ia", "ai opt out", "nao responder com ia"],
  },
];

const LEAD_TARGETS: TargetDef[] = [
  {
    field: "title",
    label: "Título do negócio",
    type: "string",
    aliases: ["titulo", "titulo do negocio", "nome do negocio", "negocio", "oportunidade", "deal", "deal name", "nome do lead", "assunto", "descricao do negocio"],
  },
  {
    field: "value",
    label: "Valor",
    type: "number",
    nonNegative: true,
    aliases: ["valor", "valor do negocio", "valor estimado", "amount", "value", "deal value", "preco", "receita", "ticket"],
  },
  { field: "currency", label: "Moeda", type: "string", aliases: ["moeda", "currency"] },
  {
    field: "priority",
    label: "Prioridade",
    type: "enum",
    aliases: ["prioridade", "priority"],
    enumValues: PRIORITY_VALUES,
  },
  {
    field: "temperature",
    label: "Temperatura",
    type: "enum",
    aliases: ["temperatura", "temperature"],
    enumValues: TEMPERATURE_VALUES,
  },
  {
    field: "tags",
    label: "Etiquetas",
    type: "tags",
    aliases: ["etiquetas", "tags", "marcadores", "rotulos", "labels"],
  },
  {
    field: "boardName",
    label: "Funil (board)",
    type: "string",
    aliases: ["board", "funil", "pipeline", "quadro", "painel", "board name", "funil de vendas"],
  },
  {
    field: "stageName",
    label: "Estágio",
    type: "string",
    aliases: ["estagio", "etapa", "stage", "fase", "coluna", "status", "estagio do funil", "stage name"],
  },
  {
    field: "sourceName",
    label: "Origem",
    type: "string",
    aliases: ["origem", "fonte", "source", "lead source", "origem do lead", "canal"],
  },
  {
    field: "assigneeEmail",
    label: "Responsável (e-mail)",
    type: "email",
    aliases: ["responsavel", "email do responsavel", "responsavel email", "dono", "owner", "assigned to", "assignee", "atendente", "vendedor", "responsible"],
  },
  {
    field: "contactEmail",
    label: "E-mail do contato",
    type: "email",
    aliases: ["email", "e mail", "email do contato", "contact email", "correio eletronico", "email principal", "email do cliente"],
  },
  {
    field: "contactPhone",
    label: "Telefone do contato",
    type: "phone",
    aliases: ["telefone", "celular", "whatsapp", "phone", "fone", "telefone do contato", "contact phone", "mobile", "numero"],
  },
  {
    field: "contactFirstName",
    label: "Nome do contato",
    type: "string",
    aliases: ["nome", "nome do contato", "contato", "first name", "primeiro nome", "cliente"],
  },
  {
    field: "contactLastName",
    label: "Sobrenome do contato",
    type: "string",
    aliases: ["sobrenome", "last name", "sobrenome do contato", "surname"],
  },
  {
    field: "contactFullName",
    label: "Nome completo do contato",
    type: "string",
    aliases: ["nome completo", "full name", "fullname", "name", "nome do cliente"],
  },
  {
    field: "contactCompany",
    label: "Empresa do contato",
    type: "string",
    aliases: ["empresa", "company", "organizacao", "razao social"],
  },
];

const TARGETS_BY_ENTITY: Record<ImportEntity, TargetDef[]> = {
  contacts: CONTACT_TARGETS,
  leads: LEAD_TARGETS,
};

/** Campos virtuais: preenchem outros campos e não existem no schema. */
const FULL_NAME_TARGETS: Record<ImportEntity, { source: string; first: string; last: string }> = {
  contacts: { source: "fullName", first: "firstName", last: "lastName" },
  leads: { source: "contactFullName", first: "contactFirstName", last: "contactLastName" },
};

/** Opções de destino para a UI de mapeamento (sem os custom fields). */
export function listImportTargets(
  entity: ImportEntity
): Array<{ field: string; label: string; type: TargetType }> {
  return TARGETS_BY_ENTITY[entity].map(({ field, label, type }) => ({ field, label, type }));
}

/** Custom fields aplicáveis à entidade (sem `entityType` = vale para as duas). */
export function filterFieldDefs(
  fieldDefs: ImportFieldDef[] | undefined,
  entity: ImportEntity
): ImportFieldDef[] {
  const wanted = entity === "contacts" ? "contact" : "lead";
  return (fieldDefs ?? []).filter(
    (def) => def.entityType === undefined || def.entityType === null || def.entityType === wanted
  );
}

// ===== Sugestão de mapeamento =====

function targetCandidates(header: string, entity: ImportEntity): string[] {
  const normalized = normalizeLabel(header);
  if (normalized === "") return [];
  const out: string[] = [];
  for (const target of TARGETS_BY_ENTITY[entity]) {
    if (
      normalizeLabel(target.field) === normalized ||
      target.aliases.some((alias) => normalizeLabel(alias) === normalized)
    ) {
      out.push(target.field);
    }
  }
  return out;
}

function customFieldCandidates(header: string, defs: ImportFieldDef[]): string[] {
  const raw = String(header ?? "").trim();
  const explicit = raw.match(/^cf[:_]\s*(.+)$/i);
  const normalized = normalizeLabel(header);
  const out: string[] = [];

  if (explicit) {
    const wanted = normalizeLabel(explicit[1]);
    for (const def of defs) {
      if (normalizeLabel(def.key) === wanted || normalizeLabel(def.name) === wanted) {
        out.push(`${CUSTOM_FIELD_PREFIX}${def.key}`);
      }
    }
    return out;
  }

  for (const def of defs) {
    if (normalizeLabel(def.key) === normalized || normalizeLabel(def.name) === normalized) {
      out.push(`${CUSTOM_FIELD_PREFIX}${def.key}`);
    }
  }
  return out;
}

/**
 * Sugere `header → campo` casando aliases PT-BR/EN (sem acento, sem caixa) e
 * custom fields por chave/nome (ou pelo prefixo explícito `cf_<key>`).
 * Um destino nunca é sugerido duas vezes: o segundo header cai no próximo
 * candidato disponível (ex.: "telefone"→phone, "whatsapp"→whatsappNumber) e,
 * não havendo candidato livre, vira `__ignore__`.
 */
export function suggestMapping(
  headers: string[],
  entity: ImportEntity,
  fieldDefs: ImportFieldDef[] = []
): ImportMapping {
  const defs = filterFieldDefs(fieldDefs, entity);
  const mapping: ImportMapping = {};
  const used = new Set<string>();

  for (const header of headers ?? []) {
    const candidates = [
      ...targetCandidates(header, entity),
      ...customFieldCandidates(header, defs),
    ];
    const picked = candidates.find((candidate) => !used.has(candidate));
    if (picked) {
      used.add(picked);
      mapping[header] = picked;
    } else {
      mapping[header] = IGNORE_FIELD;
    }
  }

  return mapping;
}

// ===== Coerção + validação de linha =====

function coerceCustomField(
  def: ImportFieldDef,
  raw: string,
  errors: RowError[],
  header: string
): unknown {
  const options = def.options ?? [];
  const matchOption = (candidate: string): string | undefined =>
    options.find((option) => normalizeLabel(option) === normalizeLabel(candidate));

  switch (def.type) {
    case "text":
      return raw;
    case "number": {
      const parsed = parseNumberValue(raw);
      if (parsed === null) {
        errors.push({ field: header, message: `"${raw}" não é um número válido` });
        return undefined;
      }
      return parsed;
    }
    case "boolean": {
      const parsed = parseBooleanValue(raw);
      if (parsed === null) {
        errors.push({ field: header, message: `"${raw}" não é sim/não válido` });
        return undefined;
      }
      return parsed;
    }
    case "date": {
      const parsed = parseDateValue(raw);
      if (parsed === null) {
        errors.push({ field: header, message: `"${raw}" não é uma data válida (aaaa-mm-dd ou dd/mm/aaaa)` });
        return undefined;
      }
      return parsed;
    }
    case "select": {
      const matched = matchOption(raw);
      if (!matched) {
        errors.push({
          field: header,
          message: `"${raw}" não é uma opção de "${def.name}" (${options.join(", ")})`,
        });
        return undefined;
      }
      return matched;
    }
    case "multiselect": {
      const parts = splitList(raw);
      const matched: string[] = [];
      for (const part of parts) {
        const option = matchOption(part);
        if (!option) {
          errors.push({
            field: header,
            message: `"${part}" não é uma opção de "${def.name}" (${options.join(", ")})`,
          });
          return undefined;
        }
        matched.push(option);
      }
      return matched;
    }
    default:
      return raw;
  }
}

function coerceTarget(
  target: TargetDef,
  raw: string,
  errors: RowError[],
  header: string
): unknown {
  switch (target.type) {
    case "string":
      return raw;
    case "email": {
      const email = raw.toLowerCase();
      if (!EMAIL_RE.test(email)) {
        errors.push({ field: header, message: `"${raw}" não é um e-mail válido` });
        return undefined;
      }
      return email;
    }
    case "phone": {
      const phone = normalizePhone(raw);
      if (phone.length < 6) {
        errors.push({ field: header, message: `"${raw}" não é um telefone válido` });
        return undefined;
      }
      return phone;
    }
    case "number": {
      const parsed = parseNumberValue(raw);
      if (parsed === null) {
        errors.push({ field: header, message: `"${raw}" não é um número válido` });
        return undefined;
      }
      if (target.nonNegative && parsed < 0) {
        errors.push({ field: header, message: `"${raw}" não pode ser negativo` });
        return undefined;
      }
      return parsed;
    }
    case "boolean": {
      const parsed = parseBooleanValue(raw);
      if (parsed === null) {
        errors.push({ field: header, message: `"${raw}" não é sim/não válido` });
        return undefined;
      }
      return parsed;
    }
    case "date": {
      const parsed = parseDateValue(raw);
      if (parsed === null) {
        errors.push({ field: header, message: `"${raw}" não é uma data válida (aaaa-mm-dd ou dd/mm/aaaa)` });
        return undefined;
      }
      return parsed;
    }
    case "tags":
      return splitList(raw);
    case "enum": {
      const canonical = target.enumValues?.[normalizeLabel(raw)];
      if (!canonical) {
        const accepted = Array.from(new Set(Object.values(target.enumValues ?? {}))).join(", ");
        errors.push({ field: header, message: `"${raw}" não é um valor aceito (${accepted})` });
        return undefined;
      }
      return canonical;
    }
    default:
      return raw;
  }
}

function splitFullName(raw: string): { first: string; last?: string } {
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "" };
  if (parts.length === 1) return { first: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/**
 * Aplica o mapeamento a uma linha crua do CSV, coagindo e validando cada
 * célula (regra 7 do plano). Devolve `{ ok: true, value }` pronto para o
 * insert/patch (com `customFields` sempre presente) ou `{ ok: false, errors }`.
 *
 * Contatos exigem ao menos um identificador (nome, e-mail ou telefone).
 * Leads exigem título — na falta dele, derivam de contato/empresa/e-mail.
 */
export function coerceAndValidateRow(
  row: Record<string, unknown>,
  mapping: ImportMapping,
  entity: ImportEntity,
  fieldDefs: ImportFieldDef[] = []
): CoerceResult {
  const errors: RowError[] = [];
  const value: Record<string, unknown> = {};
  const customFields: Record<string, unknown> = {};
  const defs = filterFieldDefs(fieldDefs, entity);
  const targets = TARGETS_BY_ENTITY[entity];
  const virtual = FULL_NAME_TARGETS[entity];
  let fullName = "";

  for (const [header, destination] of Object.entries(mapping ?? {})) {
    if (!destination || destination === IGNORE_FIELD) continue;
    const cell = row?.[header];
    const raw = cell === undefined || cell === null ? "" : String(cell).trim();

    if (destination.startsWith(CUSTOM_FIELD_PREFIX)) {
      const key = destination.slice(CUSTOM_FIELD_PREFIX.length);
      const def = defs.find((d) => d.key === key);
      if (!def) {
        errors.push({ field: header, message: `Campo personalizado "${key}" não existe nesta organização` });
        continue;
      }
      if (raw === "") {
        if (def.isRequired) {
          errors.push({ field: header, message: `"${def.name}" é obrigatório` });
        }
        continue;
      }
      const coerced = coerceCustomField(def, raw, errors, header);
      if (coerced !== undefined) customFields[key] = coerced;
      continue;
    }

    const target = targets.find((t) => t.field === destination);
    if (!target) {
      errors.push({ field: header, message: `Campo "${destination}" não existe em ${entity === "contacts" ? "contatos" : "leads"}` });
      continue;
    }
    if (raw === "") continue;

    if (target.field === virtual.source) {
      fullName = raw;
      continue;
    }

    const coerced = coerceTarget(target, raw, errors, header);
    if (coerced !== undefined) value[target.field] = coerced;
  }

  // Nome completo só preenche o que ficou vazio (coluna dedicada tem prioridade).
  if (fullName !== "") {
    const { first, last } = splitFullName(fullName);
    if (!value[virtual.first] && first) value[virtual.first] = first;
    if (!value[virtual.last] && last) value[virtual.last] = last;
  }

  if (entity === "contacts") {
    const hasIdentity =
      Boolean(value.firstName) || Boolean(value.lastName) || Boolean(value.email) || Boolean(value.phone);
    if (!hasIdentity) {
      errors.push({ message: "Linha sem nome, e-mail ou telefone — nada para importar" });
    }
  } else {
    if (!value.title) {
      const derived = [
        [value.contactFirstName, value.contactLastName].filter(Boolean).join(" ").trim(),
        value.contactCompany,
        value.contactEmail,
        value.contactPhone,
      ].find((candidate) => typeof candidate === "string" && candidate.trim() !== "");
      if (derived) value.title = String(derived).trim();
      else errors.push({ field: "title", message: "Título é obrigatório (nenhuma coluna de título, contato ou empresa preenchida)" });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  value.customFields = customFields;
  return { ok: true, value };
}
