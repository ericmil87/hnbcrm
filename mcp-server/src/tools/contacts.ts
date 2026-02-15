import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HnbCrmClient } from "../client.js";

export function registerContactTools(server: McpServer, client: HnbCrmClient) {
  server.tool(
    "crm_list_contacts",
    "List all contacts in the CRM. Returns an array of contact objects with name, email, phone, company, and enrichment data.",
    {},
    async () => {
      const result = await client.get("/api/v1/contacts");
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "crm_get_contact",
    "Get full details of a specific contact by ID, including all enrichment fields, social profiles, and custom data.",
    {
      id: z.string().describe("The contact ID to retrieve"),
    },
    async (args) => {
      const result = await client.get("/api/v1/contacts/get", { id: args.id });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "crm_create_contact",
    "Create a new contact in the CRM with personal details, company info, social profiles, and enrichment fields.",
    {
      firstName: z.string().optional().describe("First name"),
      lastName: z.string().optional().describe("Last name"),
      email: z.string().optional().describe("Email address"),
      phone: z.string().optional().describe("Phone number"),
      company: z.string().optional().describe("Company name"),
      title: z.string().optional().describe("Job title"),
    },
    async (args) => {
      const result = await client.post("/api/v1/contacts/create", args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "crm_update_contact",
    "Update an existing contact's information. Only provided fields are changed; omitted fields remain unchanged.",
    {
      contactId: z.string().describe("ID of the contact to update"),
      firstName: z.string().optional().describe("First name"),
      lastName: z.string().optional().describe("Last name"),
      email: z.string().optional().describe("Email address"),
      phone: z.string().optional().describe("Phone number"),
      company: z.string().optional().describe("Company name"),
      title: z.string().optional().describe("Job title"),
    },
    async (args) => {
      const result = await client.post("/api/v1/contacts/update", args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
