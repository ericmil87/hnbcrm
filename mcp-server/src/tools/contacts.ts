import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HnbCrmClient } from "../client.js";
import { errorResult, successResult } from "../utils.js";

// Extended fields shared by create and update
const extendedContactFields = {
  firstName: z.string().optional().describe("First name"),
  lastName: z.string().optional().describe("Last name"),
  email: z.string().optional().describe("Email address"),
  phone: z.string().optional().describe("Phone number"),
  company: z.string().optional().describe("Company name"),
  title: z.string().optional().describe("Job title"),
  tags: z.array(z.string()).optional().describe("Categorization tags"),
  whatsappNumber: z.string().optional().describe("WhatsApp number"),
  telegramUsername: z.string().optional().describe("Telegram username"),
  bio: z.string().optional().describe("Short biography"),
  linkedinUrl: z.string().optional().describe("LinkedIn profile URL"),
  instagramUrl: z.string().optional().describe("Instagram profile URL"),
  facebookUrl: z.string().optional().describe("Facebook profile URL"),
  twitterUrl: z.string().optional().describe("Twitter/X profile URL"),
  city: z.string().optional().describe("City"),
  state: z.string().optional().describe("State or province"),
  country: z.string().optional().describe("Country"),
  industry: z.string().optional().describe("Industry sector"),
  companySize: z.string().optional().describe("Company size range (e.g. '11-50', '51-200')"),
  cnpj: z.string().optional().describe("Brazilian company registration (CNPJ)"),
  companyWebsite: z.string().optional().describe("Company website URL"),
  acquisitionChannel: z.string().optional().describe("How this contact was acquired"),
  customFields: z.record(z.any()).optional().describe("Custom field key-value pairs"),
};

export function registerContactTools(server: McpServer, client: HnbCrmClient) {
  server.tool(
    "crm_list_contacts",
    "List all contacts in the CRM. Returns an array of contact objects with name, email, phone, company, and enrichment data.",
    {},
    { readOnlyHint: true, destructiveHint: false },
    async () => {
      try {
        const result = await client.get("/api/v1/contacts");
        return successResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "crm_get_contact",
    "Get full details of a specific contact by ID, including all enrichment fields, social profiles, and custom data.",
    {
      contactId: z.string().describe("The contact ID to retrieve"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        const result = await client.get("/api/v1/contacts/get", { id: args.contactId });
        return successResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "crm_create_contact",
    "Create a new contact in the CRM with personal details, company info, social profiles, location, and custom fields.",
    extendedContactFields,
    { destructiveHint: false },
    async (args) => {
      try {
        const result = await client.post("/api/v1/contacts/create", args);
        return successResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "crm_update_contact",
    "Update an existing contact's information. Only provided fields are changed; omitted fields remain unchanged.",
    {
      contactId: z.string().describe("ID of the contact to update"),
      ...extendedContactFields,
    },
    { destructiveHint: false, idempotentHint: true },
    async (args) => {
      try {
        const result = await client.post("/api/v1/contacts/update", args);
        return successResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "crm_enrich_contact",
    "Write enrichment data to a contact after AI research (e.g. from web scraping, LinkedIn lookup). Tracks data source and confidence for each enriched field.",
    {
      contactId: z.string().describe("ID of the contact to enrich"),
      fields: z.record(z.any()).describe("Key-value pairs of fields to update (e.g. { linkedinUrl: '...', industry: '...' })"),
      source: z.string().describe("Source of the enrichment data (e.g. 'linkedin', 'web_research', 'manual')"),
      confidence: z.number().min(0).max(1).optional().describe("Confidence score from 0 to 1"),
    },
    { destructiveHint: false },
    async (args) => {
      try {
        const result = await client.post("/api/v1/contacts/enrich", args);
        return successResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "crm_get_contact_gaps",
    "Get which contact fields are empty/missing. Essential for knowing what data to research before calling crm_enrich_contact.",
    {
      contactId: z.string().describe("The contact ID to check for gaps"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        const result = await client.get("/api/v1/contacts/gaps", { id: args.contactId });
        return successResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "crm_search_contacts",
    "Search contacts by name, email, company, or other text fields. More efficient than listing all contacts when looking for a specific person.",
    {
      query: z.string().describe("Search text to match against contact fields"),
      limit: z.number().optional().describe("Maximum results to return (default 20, max 100)"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        const params: Record<string, string> = { q: args.query };
        if (args.limit) params.limit = String(args.limit);
        const result = await client.get("/api/v1/contacts/search", params);
        return successResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
