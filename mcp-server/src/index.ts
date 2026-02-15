#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HnbCrmClient } from "./client.js";
import { registerLeadTools } from "./tools/leads.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerConversationTools } from "./tools/conversations.js";
import { registerHandoffTools } from "./tools/handoffs.js";
import { registerPipelineTools } from "./tools/pipeline.js";
import { registerResources } from "./resources.js";

const HNBCRM_API_URL = process.env.HNBCRM_API_URL;
const HNBCRM_API_KEY = process.env.HNBCRM_API_KEY;

if (!HNBCRM_API_URL || !HNBCRM_API_KEY) {
  console.error(
    "Missing required environment variables: HNBCRM_API_URL and HNBCRM_API_KEY"
  );
  process.exit(1);
}

const server = new McpServer({
  name: "hnbcrm",
  version: "0.1.0",
});

const client = new HnbCrmClient(HNBCRM_API_URL, HNBCRM_API_KEY);

registerLeadTools(server, client);
registerContactTools(server, client);
registerConversationTools(server, client);
registerHandoffTools(server, client);
registerPipelineTools(server, client);
registerResources(server, client);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
