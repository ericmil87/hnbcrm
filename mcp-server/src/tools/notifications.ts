import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HnbCrmClient } from "../client.js";
import { errorResult, successResult } from "../utils.js";

export function registerNotificationTools(server: McpServer, client: HnbCrmClient) {
  server.tool(
    "crm_get_notification_preferences",
    "Get the current agent's email notification preferences. Returns every flag (invite, handoffs, tasks, AI drafts, campaigns and WhatsApp groups) with its current value — absent/true means the notification is enabled (opt-out model).",
    {},
    { readOnlyHint: true, destructiveHint: false },
    async () => {
      try {
        const result = await client.get("/api/v1/notifications/preferences");
        return successResult(result);
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  server.tool(
    "crm_update_notification_preferences",
    "Update email notification preferences (e.g., disable dailyDigest for AI agents). Only provided fields are changed; omitted fields remain unchanged.",
    {
      // Conta e equipe
      invite: z.boolean().optional().describe("Convite para entrar na organização"),
      leadAssigned: z.boolean().optional().describe("Um lead foi atribuído a você"),
      newMessage: z.boolean().optional().describe("Mensagem nova numa conversa sua"),
      dailyDigest: z.boolean().optional().describe("Resumo diário da operação"),
      // Repasses IA <-> humano
      handoffRequested: z.boolean().optional().describe("Repasse da IA para um humano foi solicitado"),
      handoffResolved: z.boolean().optional().describe("Repasse foi aceito ou rejeitado"),
      // Tarefas
      taskAssigned: z.boolean().optional().describe("Tarefa atribuída a você"),
      taskOverdue: z.boolean().optional().describe("Tarefa venceu sem ser concluída"),
      taskDueSoon: z.boolean().optional().describe("Tarefa perto do prazo (lembrete antecipado)"),
      taskCommentMention: z.boolean().optional().describe("Você foi mencionado num comentário de tarefa"),
      // Atendente IA
      aiDraftPending: z
        .boolean()
        .optional()
        .describe("Rascunho do atendente IA aguardando revisão no inbox (modo sugestão)"),
      // Campanhas de WhatsApp
      campaignCompleted: z.boolean().optional().describe("Campanha de WhatsApp terminou de enviar"),
      campaignPaused: z
        .boolean()
        .optional()
        .describe("Campanha pausada automaticamente (kill switch, canal congelado ou teto atingido)"),
      // Grupos de WhatsApp
      groupJoined: z.boolean().optional().describe("O número do CRM entrou num grupo de WhatsApp"),
      groupMention: z
        .boolean()
        .optional()
        .describe("Menção ao número do CRM num grupo, ou palavra-chave de alerta detectada na sala"),
      groupPostPending: z
        .boolean()
        .optional()
        .describe("Publicação programada em grupo aguardando aprovação antes de sair"),
      groupPostFailed: z
        .boolean()
        .optional()
        .describe("Publicação programada em grupo falhou ou foi pausada"),
      groupOpportunity: z
        .boolean()
        .optional()
        .describe("Radar de oportunidade da IA identificou um possível lead numa conversa de grupo"),
      groupDigest: z.boolean().optional().describe("Resumo diário das conversas dos grupos acompanhados"),
    },
    { destructiveHint: false },
    async (args) => {
      try {
        const result = await client.put("/api/v1/notifications/preferences", args);
        return successResult(result);
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );
}
