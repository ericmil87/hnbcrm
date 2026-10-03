import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HnbCrmApiError, HnbCrmClient } from "../client.js";

export function registerConversationTools(
  server: McpServer,
  client: HnbCrmClient
) {
  server.tool(
    "crm_list_conversations",
    "List conversations, optionally filtered by lead ID. Each conversation includes its channel, status, and associated lead. By default only 1:1 conversations are returned — WhatsApp group rooms have no lead or contact and only appear with kind=group or kind=all. To send into a group, use crm_send_group_message, not crm_send_message. A conversation with `botSuspicion` and no `clearedAt` (v0.65) is one where the built-in AI attendant stopped replying because the other side looks like a bot — check the pending bot_suspect handoff before messaging it.",
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
    "Retrieve all messages in a conversation thread, ordered chronologically. Includes both customer messages and internal notes. Also works for a WhatsApp group room's conversation (its id is group.conversationId from crm_get_group). On a group, metadata.mediaDeferred marks an attachment the media policy chose not to download (v0.62) and metadata.mediaPurged marks one later removed by storage cleanup — crm_list_groups/crm_get_group do not expose these.",
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
  server.tool(
    "crm_list_whatsapp_channels",
    "List the organization's active WhatsApp numbers you can start a conversation from (use the returned id as channelConfigId in crm_start_conversation). Each item has id, provider (\"bridge\" = unofficial gateway, accepts a free-text first message; \"meta\" = official Cloud API, no free-text first message), displayName, phoneDisplay, connected and, for bridge, sessionState. Prefer a channel with connected=true. Never returns tokens, gateway URLs or instance ids.",
    {},
    async () => {
      const result = await client.get("/api/v1/conversations/channels");
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "crm_start_conversation",
    "Start (or reopen) a WhatsApp conversation with a phone number or an existing contact. Creates the contact and the lead when missing (the new lead is assigned to the API key's team member, never to the AI attendant) and reuses an existing contact/lead/conversation otherwise — calling it again for the same number just returns the same conversation. On a bridge channel the number is first verified with the WhatsApp gateway and the canonical spelling WhatsApp knows is adopted (e.g. a Brazilian mobile registered without the 9th digit); a number that is not on WhatsApp is rejected. Free-text `content` (first message) only works on bridge channels — on Meta channels start without content and send an approved template from the inbox. If the number opted out, the call fails with an opt-out error (HTTP 409): only retry with optOutAck=true AFTER a human explicitly confirms it is fine to message this person. Get channelConfigId from crm_list_whatsapp_channels.",
    {
      channelConfigId: z.string().describe("WhatsApp number to use (id from crm_list_whatsapp_channels)"),
      phone: z
        .string()
        .optional()
        .describe("Phone number, any format. Without a country code the organization's default country is assumed; use + or 00 for international. Required unless contactId is given"),
      contactId: z.string().optional().describe("Existing contact to talk to (its phone is used)"),
      firstName: z.string().optional().describe("First name, used only when a new contact is created"),
      lastName: z.string().optional().describe("Last name, used only when a new contact is created"),
      boardId: z.string().optional().describe("Pipeline for a NEW lead (default: the default pipeline)"),
      stageId: z.string().optional().describe("Stage for a NEW lead (default: first stage of the pipeline)"),
      content: z
        .string()
        .max(4096)
        .optional()
        .describe("First message. Bridge channels only — rejected on Meta channels"),
      optOutAck: z
        .boolean()
        .optional()
        .describe("Set to true ONLY after a human confirmed messaging a number that opted out (audited as high severity)"),
    },
    async (args) => {
      try {
        const result = await client.post("/api/v1/conversations/start", args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (e) {
        if (e instanceof HnbCrmApiError && e.status === 409 && e.body?.optOut) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    optOut: true,
                    error: e.message,
                    nextStep:
                      "This number asked not to receive messages. Ask a human to confirm before retrying with optOutAck: true. Do not set it on your own.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        throw e;
      }
    }
  );
}
