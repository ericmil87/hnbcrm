import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HnbCrmClient } from "../client.js";

export function registerPipelineTools(
  server: McpServer,
  client: HnbCrmClient
) {
  server.tool(
    "crm_list_boards",
    "List all pipeline boards and their stages. Each board represents a sales pipeline (e.g. 'Sales Pipeline', 'Support Queue'). Stages within each board define the workflow steps. Use stage IDs from this response when moving leads with crm_move_lead.",
    {},
    async () => {
      const result = await client.get("/api/v1/boards");
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "crm_list_team",
    "List all team members in the organization, including both human members and AI agents. Use team member IDs from this response when assigning leads with crm_assign_lead or targeting handoffs with crm_request_handoff.",
    {},
    async () => {
      const result = await client.get("/api/v1/team-members");
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
