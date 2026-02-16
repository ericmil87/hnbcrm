import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HnbCrmClient } from "../client.js";
import { errorResult, successResult } from "../utils.js";

export function registerActivityTools(
  server: McpServer,
  client: HnbCrmClient
) {
  server.tool(
    "crm_get_activities",
    "Get the activity timeline for a lead — notes, calls, emails, stage changes, assignments, and other events in reverse chronological order.",
    {
      leadId: z.string().describe("ID of the lead to get activities for"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of activities to return (default 50, max 200)"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        const params: Record<string, string> = { leadId: args.leadId };
        if (args.limit) params.limit = String(args.limit);
        const result = await client.get("/api/v1/activities", params);
        return successResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "crm_create_activity",
    "Log an activity on a lead — a note, phone call record, or email sent. Use this to track AI agent actions and observations on the lead timeline.",
    {
      leadId: z.string().describe("ID of the lead to log the activity on"),
      type: z
        .enum(["note", "call", "email_sent"])
        .describe("Type of activity: 'note' for observations, 'call' for phone calls, 'email_sent' for outbound emails"),
      content: z
        .string()
        .optional()
        .describe("Activity description or note content"),
      metadata: z
        .record(z.any())
        .optional()
        .describe("Additional structured data (e.g. { duration: '5min', outcome: 'voicemail' })"),
    },
    { destructiveHint: false },
    async (args) => {
      try {
        const result = await client.post("/api/v1/activities", args);
        return successResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
