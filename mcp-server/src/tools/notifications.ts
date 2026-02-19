import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HnbCrmClient } from "../client.js";
import { errorResult, successResult } from "../utils.js";

export function registerNotificationTools(server: McpServer, client: HnbCrmClient) {
  server.tool(
    "crm_get_notification_preferences",
    "Get the current agent's email notification preferences. Returns which event types are enabled for email notifications.",
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
      invite: z.boolean().optional().describe("Enable invite notifications"),
      handoffRequested: z.boolean().optional().describe("Enable handoff request notifications"),
      handoffResolved: z.boolean().optional().describe("Enable handoff resolved notifications"),
      taskOverdue: z.boolean().optional().describe("Enable task overdue notifications"),
      taskAssigned: z.boolean().optional().describe("Enable task assigned notifications"),
      leadAssigned: z.boolean().optional().describe("Enable lead assigned notifications"),
      newMessage: z.boolean().optional().describe("Enable new message notifications"),
      dailyDigest: z.boolean().optional().describe("Enable daily digest notifications"),
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
