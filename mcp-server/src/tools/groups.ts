import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HnbCrmClient } from "../client.js";
import { errorResult, successResult } from "../utils.js";

const postSchedule = z
  .object({
    timezone: z.string().describe("IANA timezone, e.g. 'America/Sao_Paulo'"),
    times: z.array(z.string()).describe("Local times in HH:MM, e.g. ['12:00']"),
    days: z
      .array(z.number())
      .optional()
      .describe("ISO weekdays 1=Mon..7=Sun; omit or all seven for every day"),
    startAt: z.number().optional().describe("Timestamp ms — do not publish before this"),
    endAt: z.number().optional().describe("Timestamp ms — stop publishing after this"),
    jitterMinutes: z.number().optional().describe("Random spread around each slot"),
  })
  .describe("When the post fires");

const postContent = z
  .object({
    kind: z.enum(["library", "ai"]),
    library: z
      .object({
        items: z.array(
          z.object({
            text: z.string(),
            attachmentFileIds: z.array(z.string()).optional(),
          })
        ),
        order: z.enum(["sequential", "random"]).optional(),
        noRepeatWindow: z.number().optional().describe("Do not repeat the last N items (random)"),
      })
      .optional()
      .describe("Ready-made messages rotated by the worker (kind 'library')"),
    ai: z
      .object({
        prompt: z.string().describe("What the AI should write each time"),
        persona: z.enum(["attendant", "custom"]).optional(),
        customPersona: z.string().optional(),
        requiresApproval: z
          .boolean()
          .optional()
          .describe("Default true. Setting false lets the AI publish unreviewed — requires campaigns:full"),
        generateMinutesBefore: z.number().optional(),
        onMissedApproval: z.enum(["skip", "send"]).optional(),
      })
      .optional()
      .describe("AI-generated 'message of the day' (kind 'ai')"),
  })
  .describe("What gets published");

export function registerGroupTools(server: McpServer, client: HnbCrmClient) {
  server.tool(
    "crm_list_groups",
    "List the WhatsApp groups known to the organization's bridge channels (subject, JID, member count, whether the CRM is following the room, admin flags, last activity). Following a room is opt-in per group, so a listed group is not necessarily being ingested. Requires inbox:view_own.",
    {
      channelConfigId: z.string().optional().describe("Only groups of this WhatsApp number"),
      includeRemoved: z
        .boolean()
        .optional()
        .describe("Also list groups the number has left or been removed from"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        const params: Record<string, string> = {};
        if (args.channelConfigId) params.channelConfigId = args.channelConfigId;
        if (args.includeRemoved) params.includeRemoved = "true";
        return successResult(await client.get("/api/v1/groups", params));
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "crm_get_group",
    "Get one WhatsApp group with its full participant list (name from PushName, phone, LID, admin flags, linked contact when the phone is already a contact), the AI policy for the room and the group settings. Requires inbox:view_own.",
    { groupChatId: z.string().describe("Group ID (from crm_list_groups)") },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        return successResult(
          await client.get("/api/v1/groups/get", { groupChatId: args.groupChatId })
        );
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "crm_send_group_message",
    "Send a message to a WhatsApp GROUP the CRM is following. This writes to a room with people from outside the company and cannot be unsent — be sure before calling. To mention members, put '@FirstName' in the text AND pass their JIDs in mentions. Requires inbox:view_own.",
    {
      groupChatId: z.string(),
      content: z.string().describe("Message text"),
      mentions: z
        .array(z.string())
        .optional()
        .describe("JIDs of mentioned members (LID or phone JID, from crm_get_group participants)"),
      replyToMessageId: z.string().optional().describe("Quote this message in the room"),
    },
    { destructiveHint: false },
    async (args) => {
      try {
        return successResult(await client.post("/api/v1/groups/send", args));
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "crm_list_group_posts",
    "List the scheduled group posts ('every day at noon the assistant posts in group X'): status, schedule in words, target rooms, next run and counters. Requires campaigns:view.",
    {
      status: z.enum(["draft", "active", "paused", "ended"]).optional(),
      channelConfigId: z.string().optional(),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        const params: Record<string, string> = {};
        if (args.status) params.status = args.status;
        if (args.channelConfigId) params.channelConfigId = args.channelConfigId;
        return successResult(await client.get("/api/v1/group-posts", params));
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "crm_get_group_post",
    "Get a scheduled group post: targets, schedule, content (message library or AI prompt), stats and any text waiting for approval. Requires campaigns:view.",
    { groupPostId: z.string() },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        return successResult(
          await client.get("/api/v1/group-posts/get", { groupPostId: args.groupPostId })
        );
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "crm_create_group_post",
    "Create a scheduled group post as a DRAFT. It NEVER publishes on its own and this tool cannot activate it: turning it on makes the CRM write by itself in real WhatsApp groups, so it is a human decision taken in the app (campaigns:full). All target groups must be followed rooms of the SAME WhatsApp number. Requires campaigns:manage.",
    {
      name: z.string().describe("Name of the routine, e.g. 'Bom dia da manhã'"),
      groupChatIds: z.array(z.string()).describe("Target groups (same channel, all followed)"),
      schedule: postSchedule,
      content: postContent,
    },
    { destructiveHint: false },
    async (args) => {
      try {
        return successResult(await client.post("/api/v1/group-posts/create", args));
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "crm_pause_group_post",
    "Pause an active scheduled group post — publishing stops immediately and it can be activated again later. Requires campaigns:manage.",
    { groupPostId: z.string(), reason: z.string().optional() },
    { destructiveHint: false },
    async (args) => {
      try {
        return successResult(await client.post("/api/v1/group-posts/pause", args));
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "crm_approve_group_post",
    "Approve the AI-generated text waiting for review on a scheduled group post, optionally replacing it with an edited version. Once approved it is published at the slot it was generated for. Requires campaigns:manage.",
    {
      groupPostId: z.string(),
      editedText: z.string().optional().describe("Publish this text instead of the generated one"),
    },
    { destructiveHint: false },
    async (args) => {
      try {
        return successResult(await client.post("/api/v1/group-posts/approve", args));
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );

}
