import {
  Users,
  UserCircle,
  Building2,
  UserPlus,
  ArrowRightLeft,
  MessageSquare,
  LayoutDashboard,
  Layers,
  Webhook,
  Radio,
  SlidersHorizontal,
  Key,
  BookmarkCheck,
} from "lucide-react";

// Entity icon mapping
export const ENTITY_ICONS: Record<string, any> = {
  lead: Users,
  contact: UserCircle,
  organization: Building2,
  teamMember: UserPlus,
  handoff: ArrowRightLeft,
  message: MessageSquare,
  board: LayoutDashboard,
  stage: Layers,
  webhook: Webhook,
  leadSource: Radio,
  fieldDefinition: SlidersHorizontal,
  apiKey: Key,
  savedView: BookmarkCheck,
};

// Action badge mapping
export const ACTION_LABELS: Record<string, { label: string; variant: string }> = {
  create: { label: "Criar", variant: "success" },
  update: { label: "Atualizar", variant: "info" },
  delete: { label: "Excluir", variant: "error" },
  move: { label: "Mover", variant: "brand" },
  assign: { label: "Atribuir", variant: "info" },
  handoff: { label: "Pedir ajuda", variant: "warning" },
};

// Field label mapping for diff table
export const FIELD_LABELS: Record<string, string> = {
  stageId: "Etapa",
  assignedTo: "Responsável",
  status: "Status",
  priority: "Prioridade",
  title: "Título",
  name: "Nome",
  value: "Valor",
  email: "E-mail",
  phone: "Telefone",
  company: "Empresa",
  temperature: "Temperatura",
  tags: "Etiquetas",
  qualification: "Qualificação",
  contactId: "Contato",
};

// Date grouping utility
export function getDateGroup(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);
  const monthAgo = new Date(today.getTime() - 30 * 86400000);

  if (date >= today) return "Hoje";
  if (date >= yesterday) return "Ontem";
  if (date >= weekAgo) return "Esta Semana";
  if (date >= monthAgo) return "Este Mês";
  return "Anteriores";
}

// Relative time utility
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "agora";
  if (mins < 60) return `${mins}min atrás`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h atrás`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d atrás`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}sem atrás`;
  return new Date(timestamp).toLocaleDateString("pt-BR");
}

// Client-side description fallback
export const ACTION_VERBS_PTBR: Record<string, string> = {
  create: "Criou",
  update: "Atualizou",
  delete: "Excluiu",
  move: "Moveu",
  assign: "Atribuiu",
  handoff: "Pediu ajuda",
};

export const ENTITY_LABELS_PTBR: Record<string, { article: string; label: string }> = {
  lead: { article: "o", label: "lead" },
  contact: { article: "o", label: "contato" },
  organization: { article: "a", label: "organização" },
  teamMember: { article: "o", label: "membro" },
  handoff: { article: "o", label: "pedido de ajuda" },
  message: { article: "a", label: "mensagem" },
  board: { article: "o", label: "quadro" },
  stage: { article: "a", label: "etapa" },
  webhook: { article: "o", label: "webhook" },
  leadSource: { article: "a", label: "fonte de lead" },
  fieldDefinition: { article: "o", label: "campo personalizado" },
  apiKey: { article: "a", label: "chave de API" },
  savedView: { article: "a", label: "visualização salva" },
};

export function buildClientDescription(log: any): string {
  const verb = ACTION_VERBS_PTBR[log.action] || log.action;
  const entity = ENTITY_LABELS_PTBR[log.entityType];
  const article = entity?.article || "o";
  const label = entity?.label || log.entityType;
  const meta = log.metadata as Record<string, unknown> | undefined;
  const name = (meta?.title as string) || (meta?.name as string) || "";
  const nameStr = name ? ` '${name}'` : "";
  return `${verb} ${article} ${label}${nameStr}`;
}

// Value formatter for diff
export function formatDiffValue(val: unknown): string {
  if (val === undefined || val === null) return "—";
  if (typeof val === "boolean") return val ? "Sim" : "Não";
  if (typeof val === "number") return String(val);
  if (Array.isArray(val)) return val.join(", ") || "—";
  if (typeof val === "object") return "Atualizado";
  return String(val);
}

// Group logs by date label (extracted from AuditLogs IIFE)
export function groupLogsByDate(logs: any[]): { label: string; logs: any[] }[] {
  const groups: { label: string; logs: any[] }[] = [];
  let currentGroup: string | null = null;

  for (const log of logs) {
    const group = getDateGroup(log.createdAt);
    if (group !== currentGroup) {
      groups.push({ label: group, logs: [log] });
      currentGroup = group;
    } else {
      groups[groups.length - 1].logs.push(log);
    }
  }

  return groups;
}
