#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HnbCrmClient } from "./client.js";
import { registerLeadTools } from "./tools/leads.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerConversationTools } from "./tools/conversations.js";
import { registerHandoffTools } from "./tools/handoffs.js";
import { registerPipelineTools } from "./tools/pipeline.js";
import { registerActivityTools } from "./tools/activities.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerNotificationTools } from "./tools/notifications.js";
import { registerResources } from "./resources.js";

function createServer(apiUrl: string, apiKey: string) {
  const server = new McpServer({
    name: "hnbcrm",
    version: "0.1.0",
  });

  const client = new HnbCrmClient(apiUrl, apiKey);

  registerLeadTools(server, client);
  registerContactTools(server, client);
  registerConversationTools(server, client);
  registerHandoffTools(server, client);
  registerPipelineTools(server, client);
  registerActivityTools(server, client);
  registerTaskTools(server, client);
  registerCalendarTools(server, client);
  registerNotificationTools(server, client);
  registerResources(server, client);

  return server;
}

async function main() {
  if (!process.env.HNBCRM_API_URL || !process.env.HNBCRM_API_KEY) {
    console.error(
      "Missing required environment variables: HNBCRM_API_URL and HNBCRM_API_KEY"
    );
    process.exit(1);
  }

  const server = createServer(process.env.HNBCRM_API_URL, process.env.HNBCRM_API_KEY);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run stdio transport when executed directly
if (process.env.HNBCRM_API_URL) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
