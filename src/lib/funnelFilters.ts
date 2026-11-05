
export const getPriorityVariant = (priority: string): "error" | "warning" | "default" => {
  if (priority === "urgent") return "error";
  if (priority === "high") return "warning";
  return "default";
};

export const getTemperatureVariant = (temperature: string): "error" | "warning" | "info" => {
  if (temperature === "hot") return "error";
  if (temperature === "warm") return "warning";
  return "info";
};

export const getPriorityLabel = (priority: string): string => {
  const labels: Record<string, string> = {
    urgent: "Urgente",
    high: "Alta",
    medium: "Média",
    low: "Baixa",
  };
  return labels[priority] || priority;
};

export const getTemperatureLabel = (temperature: string): string => {
  const labels: Record<string, string> = {
    hot: "Quente",
    warm: "Morno",
    cold: "Frio",
  };
  return labels[temperature] || temperature;
};

export const PRIORITY_VALUES = ["urgent", "high", "medium", "low"] as const;
export const TEMPERATURE_VALUES = ["hot", "warm", "cold"] as const;
export type FunnelView = "board" | "list";

/** Filtros e modo do Funil, tal como moram na URL (`?view=&q=&owner=&temp=&priority=&unit=`). */
export interface FunnelFilters {
  view: FunnelView;
  q: string;
  /** `"all"` | `"unassigned"` | id do membro. */
  owner: string;
  /** `"all"` | `hot|warm|cold`. */
  temp: string;
  /** `"all"` | `urgent|high|medium|low`. */
  priority: string;
  /** `"all"` | `"none"` | id da unidade. */
  unit: string;
}

export const DEFAULT_FUNNEL_FILTERS: FunnelFilters = {
  view: "board",
  q: "",
  owner: "all",
  temp: "all",
  priority: "all",
  unit: "all",
};

const FILTER_KEYS = ["view", "q", "owner", "temp", "priority", "unit"] as const;

/** Lê os filtros da URL; valor ausente ou inválido cai no padrão. */
export function parseFunnelFilters(search: string | URLSearchParams): FunnelFilters {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const pick = (key: "temp" | "priority", allowed: readonly string[]) => {
    const raw = params.get(key);
    return raw && allowed.includes(raw) ? raw : "all";
  };
  return {
    view: params.get("view") === "list" ? "list" : "board",
    q: params.get("q") ?? "",
    owner: params.get("owner")?.trim() || "all",
    temp: pick("temp", TEMPERATURE_VALUES),
    priority: pick("priority", PRIORITY_VALUES),
    unit: params.get("unit")?.trim() || "all",
  };
}

/** Aplica mudanças de filtro sobre os parâmetros atuais; valores padrão saem da URL. */
export function writeFunnelFilters(
  prev: URLSearchParams,
  changes: Partial<FunnelFilters>
): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const key of FILTER_KEYS) {
    if (!(key in changes)) continue;
    const value = changes[key];
    if (value === undefined || value === DEFAULT_FUNNEL_FILTERS[key]) next.delete(key);
    else next.set(key, value);
  }
  return next;
}

/**
 * `?owner=`/`?unit=` com id que não existe mais (membro removido, unidade
 * excluída, link antigo) valem como "todos", igual ao que o Select mostra.
 * Lista ainda não carregada (`undefined`) não invalida nada.
 */
export function normalizeFunnelFilters(
  filters: FunnelFilters,
  known: { memberIds?: readonly string[]; unitIds?: readonly string[] }
): FunnelFilters {
  const owner =
    known.memberIds &&
    filters.owner !== "all" &&
    filters.owner !== "unassigned" &&
    !known.memberIds.includes(filters.owner)
      ? "all"
      : filters.owner;
  const unit =
    known.unitIds &&
    filters.unit !== "all" &&
    filters.unit !== "none" &&
    !known.unitIds.includes(filters.unit)
      ? "all"
      : filters.unit;
  return owner === filters.owner && unit === filters.unit ? filters : { ...filters, owner, unit };
}

/** Quantos filtros (sem contar o modo) estão ativos. */
export function activeFilterCount(filters: FunnelFilters): number {
  return (
    (filters.q ? 1 : 0) +
    (filters.owner !== "all" ? 1 : 0) +
    (filters.temp !== "all" ? 1 : 0) +
    (filters.priority !== "all" ? 1 : 0) +
    (filters.unit !== "all" ? 1 : 0)
  );
}

export interface FilterableLead {
  title: string;
  priority: string;
  temperature: string;
  assignee?: { _id: string } | null;
  unitId?: string;
}

/** Filtro client-side. `unit` só vale com o módulo de unidades ligado. */
export function filterLeads<T extends FilterableLead>(
  leads: readonly T[] | undefined,
  filters: FunnelFilters,
  unitsEnabled: boolean
): T[] {
  if (!leads) return [];
  const query = filters.q.toLowerCase();
  const unit = unitsEnabled ? filters.unit : "all";
  return leads.filter((lead) => {
    if (query && !lead.title.toLowerCase().includes(query)) return false;
    if (filters.priority !== "all" && lead.priority !== filters.priority) return false;
    if (filters.temp !== "all" && lead.temperature !== filters.temp) return false;
    if (filters.owner !== "all") {
      if (filters.owner === "unassigned") {
        if (lead.assignee) return false;
      } else if (lead.assignee?._id !== filters.owner) {
        return false;
      }
    }
    if (unit !== "all") {
      if (unit === "none" ? !!lead.unitId : lead.unitId !== unit) return false;
    }
    return true;
  });
}

export type SortKey =
  | "title"
  | "value"
  | "stage"
  | "priority"
  | "temperature"
  | "assignee"
  | "updatedAt";
export type SortOrder = "asc" | "desc";

export interface SortableLead {
  title?: string;
  value?: number;
  stage?: { name?: string } | null;
  priority?: string;
  temperature?: string;
  assignee?: { name?: string } | null;
  updatedAt?: number;
  lastActivityAt?: number;
}

const PRIORITY_RANK: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1 };
const TEMPERATURE_RANK: Record<string, number> = { hot: 3, warm: 2, cold: 1 };

/** Ordenação da lista (o quadro mantém a ordem por etapa). Não altera o array de entrada. */
export function sortLeads<T extends SortableLead>(
  leads: readonly T[],
  sortKey: SortKey,
  sortOrder: SortOrder
): T[] {
  const sortValue = (lead: T): string | number => {
    switch (sortKey) {
      case "title": return (lead.title ?? "").toLowerCase();
      case "value": return lead.value ?? 0;
      case "stage": return (lead.stage?.name ?? "").toLowerCase();
      case "priority": return PRIORITY_RANK[lead.priority ?? ""] ?? 0;
      case "temperature": return TEMPERATURE_RANK[lead.temperature ?? ""] ?? 0;
      case "assignee": return (lead.assignee?.name ?? "").toLowerCase();
      case "updatedAt":
      default: return lead.updatedAt ?? lead.lastActivityAt ?? 0;
    }
  };
  const dir = sortOrder === "asc" ? 1 : -1;
  return [...leads].sort((a, b) => {
    const av = sortValue(a);
    const bv = sortValue(b);
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv), "pt-BR") * dir;
  });
}

/** Padrão de direção ao trocar a coluna: texto cresce, número/recência desce. */
export function defaultSortOrder(key: SortKey): SortOrder {
  return key === "title" || key === "stage" || key === "assignee" ? "asc" : "desc";
}

export const PRIORITY_FILTER_OPTIONS = [
  { value: "all", label: "Todas prioridades" },
  { value: "urgent", label: "Urgente" },
  { value: "high", label: "Alta" },
  { value: "medium", label: "Média" },
  { value: "low", label: "Baixa" },
];

export const TEMPERATURE_FILTER_OPTIONS = [
  { value: "all", label: "Todas temperaturas" },
  { value: "hot", label: "Quente" },
  { value: "warm", label: "Morno" },
  { value: "cold", label: "Frio" },
];

/** Chave do "último funil visto" por organização (preferência pessoal, fica no navegador). */
export function lastBoardStorageKey(organizationId: string): string {
  return `hnbcrm.lastBoard.${organizationId}`;
}

/** Funil inicial: `?board=` válido > último visto (localStorage) > primeiro da lista. */
export function pickInitialBoardId(
  boards: readonly { _id: string }[],
  boardParam: string | null,
  storedBoardId: string | null
): string | null {
  if (boards.length === 0) return null;
  const has = (id: string | null) => !!id && boards.some((b) => b._id === id);
  if (has(boardParam)) return boardParam;
  if (has(storedBoardId)) return storedBoardId;
  return boards[0]._id;
}
