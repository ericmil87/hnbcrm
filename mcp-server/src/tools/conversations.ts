import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HnbCrmClient } from "../client.js";

export function registerConversationTools(
  server: McpServer,
  client: HnbCrmClient
) {
  server.tool(
    "crm_list_conversations",
    "List conversations, optionally filtered by lead ID. Each conversation includes its channel, status, and associated lead. By default only 1:1 conversations are returned — WhatsApp group rooms have no lead or contact and only appear with kind=group or kind=all. To send into a group, use crm_send_group_message, not crm_send_message.",
    {
      leadId: z.string().optional().describe("Filter by lead ID"),
      kind: z
        .enum(["direct", "group", "all"])
        .optional()
        .describe("direct (default) = 1:1 only; group = WhatsApp group rooms; all = both"),
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (args.leadId) params.leadId = args.leadId;
      if (args.kind) params.kind = args.kind;
      const result = await client.get("/api/v1/conversations", params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "crm_get_messages",
    "Retrieve all messages in a conversation thread, ordered chronologically. Includes both customer messages and internal notes.",
    {
      conversationId: z.string().describe("The conversation ID"),
    },
    async (args) => {
      const result = await client.get("/api/v1/conversations/messages", {
        conversationId: args.conversationId,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "crm_send_message",
    "Send a message in a conversation. Can be a customer-facing reply or an internal note visible only to team members. Use isInternal=true for notes between team members.",
    {
      conversationId: z.string().describe("The conversation ID to send to"),
      content: z.string().describe("Message content"),
      isInternal: z
        .boolean()
        .optional()
        .describe("If true, message is an internal note (not visible to customer)"),
      contentType: z
        .string()
        .optional()
        .describe("Content type (default: text)"),
    },
    async (args) => {
      const result = await client.post("/api/v1/conversations/send", args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
