import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HnbCrmClient } from "../client.js";

export function registerHandoffTools(
  server: McpServer,
  client: HnbCrmClient
) {
  server.tool(
    "crm_request_handoff",
    "Request an AI-to-human handoff for a lead. Used when the AI agent determines a human team member should take over — for example, when a deal reaches negotiation stage or the customer asks for a human. Provide a reason and optional summary of the conversation so far.",
    {
      leadId: z.string().describe("ID of the lead to hand off"),
      reason: z.string().describe("Why the handoff is needed"),
      toMemberId: z
        .string()
        .optional()
        .describe("Specific team member to hand off to (optional)"),
      summary: z
        .string()
        .optional()
        .describe("Summary of conversation and context for the human"),
      suggestedActions: z
        .array(z.string())
        .optional()
        .describe("Suggested next steps for the human"),
    },
    async (args) => {
      const result = await client.post("/api/v1/leads/handoff", args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "crm_list_handoffs",
    "List handoff requests, optionally filtered by status (pending, accepted, or rejected). Useful for monitoring the AI-to-human handoff queue.",
    {
      status: z
        .enum(["pending", "accepted", "rejected"])
        .optional()
        .describe("Filter by handoff status"),
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (args.status) params.status = args.status;
      const result = await client.get("/api/v1/handoffs", params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "crm_accept_handoff",
    "Accept a pending handoff request, taking ownership of the lead from the AI agent. Optionally add notes about the acceptance.",
    {
      handoffId: z.string().describe("ID of the handoff to accept"),
      notes: z.string().optional().describe("Notes about accepting the handoff"),
    },
    async (args) => {
      const result = await client.post("/api/v1/handoffs/accept", args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
