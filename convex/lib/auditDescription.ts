/**
 * Generates human-readable PT-BR descriptions for audit log entries.
 */

const ENTITY_LABELS: Record<string, { article: string; label: string }> = {
  lead: { article: "o", label: "lead" },
  contact: { article: "o", label: "contato" },
  organization: { article: "a", label: "organização" },
  teamMember: { article: "o", label: "membro" },
  handoff: { article: "o", label: "repasse" },
  message: { article: "a", label: "mensagem" },
  board: { article: "o", label: "quadro" },
  stage: { article: "a", label: "etapa" },
  webhook: { article: "o", label: "webhook" },
  leadSource: { article: "a", label: "fonte de lead" },
  fieldDefinition: { article: "o", label: "campo personalizado" },
  apiKey: { article: "a", label: "chave de API" },
  savedView: { article: "a", label: "visualização salva" },
  task: { article: "a", label: "tarefa" },
  calendarEvent: { article: "o", label: "evento" },
  form: { article: "o", label: "formulário" },
  formSubmission: { article: "a", label: "submissão de formulário" },
};

const ACTION_VERBS: Record<string, string> = {
  create: "Criou",
  update: "Atualizou",
  delete: "Excluiu",
  move: "Moveu",
  assign: "Atribuiu",
  handoff: "Repassou",
};

interface BuildDescriptionArgs {
  action: string;
  entityType: string;
  metadata?: Record<string, unknown>;
  changes?: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  };
}

export function buildAuditDescription({
  action,
  entityType,
  metadata,
  changes,
}: BuildDescriptionArgs): string {
  const verb = ACTION_VERBS[action] || action;
  const entity = ENTITY_LABELS[entityType];
  const article = entity?.article || "o";
  const label = entity?.label || entityType;

  const name =
    (metadata?.title as string) ||
    (metadata?.name as string) ||
    "";

  const nameStr = name ? ` '${name}'` : "";

  // Special cases
  if (action === "move" && metadata?.fromStageName && metadata?.toStageName) {
    return `${verb} ${article} ${label}${nameStr} de '${metadata.fromStageName}' para '${metadata.toStageName}'`;
  }

  if (action === "assign" && metadata?.assigneeName) {
    return `${verb} ${article} ${label}${nameStr} para ${metadata.assigneeName}`;
  }

  if (action === "handoff") {
    const parts = [verb, article, label];
    if (nameStr) parts.push(nameStr.trim());
    if (metadata?.fromMemberName && metadata?.toMemberName) {
      return `${parts.join(" ")} de ${metadata.fromMemberName} para ${metadata.toMemberName}`;
    }
    if (metadata?.toMemberName) {
      return `${parts.join(" ")} para ${metadata.toMemberName}`;
    }
    return parts.join(" ");
  }

  if (action === "update" && changes?.after) {
    const fields = Object.keys(changes.after);
    if (fields.length === 1) {
      return `${verb} ${article} ${label}${nameStr} (${fields[0]})`;
    }
    if (fields.length > 1) {
      return `${verb} ${article} ${label}${nameStr} (${fields.length} campos)`;
    }
  }

  return `${verb} ${article} ${label}${nameStr}`;
}
