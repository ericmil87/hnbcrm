/**
 * Enforcement server-side das ações de IA — as 4 camadas de defesa do plano
 * (docs/AI-AGENT-CONFIG-PLAN-v2.md §3.2). Nenhuma função chamável por IA pode
 * confiar no runtime do modelo: TODA leitura/escrita agentada passa por aqui.
 *
 * Camada 1: assertAgentCan — permissão RBAC + org do ator == org da entidade.
 * Camada 2: assertRecordScope — o atendente só opera sobre o lead/conversa/
 *           contato do gatilho (escopo por REGISTRO, não só por verbo).
 * Camada 3: TOOL_DENYLIST + teste de build (agentToolSecurity.test.ts) — nomes
 *           que NUNCA podem virar tool + regex de campos-segredo no retorno.
 * Camada 4: envelope de dado não-confiável (lib/promptEnvelope.ts).
 */
import { QueryCtx, MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import {
  resolvePermissions,
  hasPermission,
  type PermissionCategory,
  type Permissions,
  type Role,
} from "./permissions";

/**
 * Funções que NUNCA podem ser registradas como tool de IA — retornam segredos
 * em claro ou descriptografados. O teste de build falha se qualquer nome daqui
 * aparecer no registry de tools.
 */
export const TOOL_DENYLIST: readonly string[] = [
  "internalGetConfig",
  "internalGetBridgeCredentials",
  "decryptSecret",
  "internalGetDispatchContext", // retorna o doc channelConfig cru (tokens cifrados)
  "internalGetConfigByPhoneNumberId",
  "internalGetConfigByBridgeInstanceId",
  "internalGetActiveConfigByVerifyToken",
  "internalGetDefaultActiveConfig",
  "internalGetOrgSecretEncrypted", // BYO key cifrada — só o runtime lê
];

/**
 * Regex de campos-segredo: nenhum retorno de tool exposta pode conter chave
 * casando este padrão (validado pelo teste de build camada 3).
 */
export const SECRET_FIELD_PATTERN = /(Encrypted|token|secret|apiKey|verifyToken)/i;

/** Escopo de registro de uma run do atendente — os únicos IDs que ele pode tocar. */
export interface AgentRecordScope {
  organizationId: Id<"organizations">;
  conversationId: Id<"conversations">;
  leadId: Id<"leads">;
  contactId?: Id<"contacts">;
}

type EntityWithOrg = { organizationId: Id<"organizations"> };

/**
 * Camada 1 — gate de permissão + org para toda função chamável por IA.
 * Carrega o teamMember agente, resolve o RBAC (mesma lógica de requirePermission,
 * mas sem sessão de auth — o chamador é o runtime, não um usuário logado) e
 * assevera que a entidade-alvo pertence à MESMA org do agente.
 *
 * Retorna o teamMember para o chamador usar como ator (attribution).
 */
export async function assertAgentCan(
  ctx: QueryCtx | MutationCtx,
  agentMemberId: Id<"teamMembers">,
  category: PermissionCategory,
  requiredLevel: string,
  entity?: EntityWithOrg | null
): Promise<Doc<"teamMembers">> {
  const member = await ctx.db.get(agentMemberId);
  if (!member) throw new Error("Agente não encontrado");
  if (member.status !== "active") throw new Error("Agente inativo");

  const permissions = resolvePermissions(
    member.role as Role,
    (member as { permissions?: Permissions }).permissions
  );
  if (!hasPermission(permissions, category, requiredLevel)) {
    throw new Error("Permissão insuficiente para o agente");
  }

  if (entity && entity.organizationId !== member.organizationId) {
    throw new Error("Entidade não pertence à organização do agente");
  }

  return member;
}

/**
 * Camada 2 — escopo por registro do atendente: a entidade tem de ser exatamente
 * o lead/conversa/contato do atendimento em curso. IDs vêm do GATILHO (nunca do
 * modelo); qualquer id fora do escopo é recusado mesmo com permissão RBAC.
 */
export function assertRecordScope(
  scope: AgentRecordScope,
  target:
    | { kind: "lead"; id: Id<"leads"> }
    | { kind: "conversation"; id: Id<"conversations"> }
    | { kind: "contact"; id: Id<"contacts"> }
): void {
  const allowed =
    (target.kind === "lead" && target.id === scope.leadId) ||
    (target.kind === "conversation" && target.id === scope.conversationId) ||
    (target.kind === "contact" && scope.contactId !== undefined && target.id === scope.contactId);
  if (!allowed) {
    throw new Error("Registro fora do escopo do atendimento em curso");
  }
}

/**
 * Gate de ativação da IA da org: enabled === true E aceite LGPD registrado.
 * Orgs legadas com enabled:true sem lgpdAck continuam DESLIGADAS — a ativação
 * real acontece na seção IA (que grava o ack). Toda entrada de runtime chama isto.
 */
export function orgAiActive(org: Doc<"organizations"> | null): boolean {
  const aiConfig = org?.settings.aiConfig;
  return !!aiConfig && aiConfig.enabled === true && aiConfig.lgpdAck !== undefined;
}
