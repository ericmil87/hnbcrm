import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HnbCrmClient } from "../client.js";

export function registerLeadTools(server: McpServer, client: HnbCrmClient) {
  server.tool(
    "crm_create_lead",
    "Create a new lead in the CRM pipeline. Optionally attach a contact (by name, email, phone, or company) and an initial message. The lead is placed in the default board's first stage automatically.",
    {
      title: z.string().describe("Lead title or deal name"),
      contact: z
        .object({
          firstName: z.string().optional(),
          lastName: z.string().optional(),
          email: z.string().optional(),
          phone: z.string().optional(),
          company: z.string().optional(),
        })
        .optional()
        .describe("Contact info — existing contacts are matched by email/phone"),
      value: z.number().optional().describe("Monetary value of the deal"),
      priority: z
        .enum(["low", "medium", "high", "urgent"])
        .optional()
        .describe("Lead priority level"),
      temperature: z
        .enum(["cold", "warm", "hot"])
        .optional()
        .describe("How engaged the lead is"),
      tags: z.array(z.string()).optional().describe("Categorization tags"),
      customFields: z
        .record(z.any())
        .optional()
        .describe("Custom field key-value pairs"),
      sourceId: z.string().optional().describe("Lead source ID"),
      message: z
        .string()
        .optional()
        .describe("Initial message to create a conversation thread"),
      channel: z
        .string()
        .optional()
        .describe("Channel for the initial message (e.g. webchat, email, whatsapp)"),
    },
    async (args) => {
      const result = await client.post("/api/v1/inbound/lead", args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "crm_list_leads",
    "List leads in the CRM, optionally filtered by board, stage, or assignee. Returns an array of lead objects with their current status, value, and assigned team member.",
    {
      boardId: z.string().optional().describe("Filter by board ID"),
      stageId: z.string().optional().describe("Filter by pipeline stage ID"),
      assignedTo: z
        .string()
        .optional()
        .describe("Filter by assigned team member ID"),
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (args.boardId) params.boardId = args.boardId;
      if (args.stageId) params.stageId = args.stageId;
      if (args.assignedTo) params.assignedTo = args.assignedTo;
      const result = await client.get("/api/v1/leads", params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "crm_get_lead",
    "Get full details of a specific lead by its ID, including contact info, current stage, custom fields, and assignment.",
    {
      leadId: z.string().describe("The lead ID to retrieve"),
    },
    async (args) => {
      const result = await client.get("/api/v1/leads/get", { id: args.leadId });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "crm_update_lead",
    "Update properties of an existing lead such as title, value, priority, temperature, tags, or custom fields.",
    {
      leadId: z.string().describe("ID of the lead to update"),
      title: z.string().optional().describe("New lead title"),
      value: z.number().optional().describe("New monetary value"),
      priority: z
        .enum(["low", "medium", "high", "urgent"])
        .optional()
        .describe("New priority level"),
      temperature: z
        .enum(["cold", "warm", "hot"])
        .optional()
        .describe("New temperature"),
      tags: z.array(z.string()).optional().describe("Replace tags"),
      customFields: z
        .record(z.any())
        .optional()
        .describe("Custom field key-value pairs"),
      sourceId: z.string().optional().describe("New source ID"),
      qualification: z
        .object({
          budget: z.boolean().optional().describe("Can afford the solution"),
          authority: z.boolean().optional().describe("Is the decision-maker"),
          need: z.boolean().optional().describe("Has a clear pain point"),
          timeline: z.boolean().optional().describe("Has urgency to buy"),
          score: z.number().optional().describe("Count of true values (0-4)"),
        })
        .optional()
        .describe("BANT qualification scoring"),
    },
    async (args) => {
      const result = await client.post("/api/v1/leads/update", args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "crm_delete_lead",
    "Permanently delete a lead from the CRM. This action cannot be undone.",
    {
      leadId: z.string().describe("ID of the lead to delete"),
    },
    async (args) => {
      const result = await client.post("/api/v1/leads/delete", args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "crm_move_lead",
    "Move a lead to a different stage in the pipeline (e.g. from 'Qualification' to 'Proposal'). Use crm_list_boards to find available stage IDs.",
    {
      leadId: z.string().describe("ID of the lead to move"),
      stageId: z.string().describe("Target stage ID"),
    },
    async (args) => {
      const result = await client.post("/api/v1/leads/move-stage", args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "crm_assign_lead",
    "Assign a lead to a team member (human or AI agent). Omit assignedTo to unassign. Use crm_list_team to find team member IDs.",
    {
      leadId: z.string().describe("ID of the lead to assign"),
      assignedTo: z
        .string()
        .optional()
        .describe("Team member ID to assign to (omit to unassign)"),
    },
    async (args) => {
      const result = await client.post("/api/v1/leads/assign", args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
