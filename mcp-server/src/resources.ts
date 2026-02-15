import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HnbCrmClient } from "./client.js";

export function registerResources(server: McpServer, client: HnbCrmClient) {
  server.resource(
    "boards",
    "hnbcrm://boards",
    {
      description:
        "Pipeline boards and stages configured in this HNBCRM organization. Use these IDs when creating or moving leads.",
      mimeType: "application/json",
    },
    async () => {
      const result = await client.get("/api/v1/boards");
      return {
        contents: [
          {
            uri: "hnbcrm://boards",
            mimeType: "application/json",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.resource(
    "team",
    "hnbcrm://team",
    {
      description:
        "Team members (humans and AI agents) in this HNBCRM organization. Use these IDs for lead assignment and handoffs.",
      mimeType: "application/json",
    },
    async () => {
      const result = await client.get("/api/v1/team-members");
      return {
        contents: [
          {
            uri: "hnbcrm://team",
            mimeType: "application/json",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.resource(
    "fields",
    "hnbcrm://fields",
    {
      description:
        "Custom field definitions available in this HNBCRM organization. Shows field names, types, and options for use with lead and contact custom fields.",
      mimeType: "application/json",
    },
    async () => {
      const result = await client.get("/api/v1/field-definitions");
      return {
        contents: [
          {
            uri: "hnbcrm://fields",
            mimeType: "application/json",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
