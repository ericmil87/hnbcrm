import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HnbCrmClient } from "../client.js";
import { errorResult, successResult } from "../utils.js";

const audienceFilters = z
  .object({
    boardId: z.string().optional(),
    stageIds: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    assignedTo: z.string().optional(),
    temperature: z.enum(["cold", "warm", "hot"]).optional(),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    lastActivityBefore: z.number().optional().describe("Timestamp ms — only leads inactive since before this"),
    lastActivityAfter: z.number().optional().describe("Timestamp ms — only leads active after this"),
    onlyOpenWindow: z.boolean().optional().describe("Only recipients with an open 24h WhatsApp window (Meta)"),
    excludeCampaignedWithinDays: z.number().optional(),
    excludeRepliedToCampaigns: z.boolean().optional(),
  })
  .describe("Segment filters (for audience.source = 'segment')");

const memberFilters = z
  .object({
    excludeAdmins: z.boolean().optional(),
    excludeExistingContacts: z.boolean().optional().describe("Drop members who already are contacts"),
    excludeCampaignedWithinDays: z.number().optional(),
    activeInGroupWithinDays: z.number().optional().describe("Only members who spoke in the group in the last N days"),
    excludeGroupChatIds: z.array(z.string()).optional().describe("Drop members who also belong to these groups"),
    includeKeys: z
      .array(z.string())
      .optional()
      .describe(
        "Only these members (participant key = `lid ?? phone`, as returned by preview-audience `members[].key`). Empty = every eligible member."
      ),
  })
  .describe("Member filters (for audience.source = 'group_members')");

export function registerCampaignTools(server: McpServer, client: HnbCrmClient) {
  server.tool(
    "crm_list_campaigns",
    "List WhatsApp bulk-messaging campaigns with status, channel and counters (sent, delivered, read, replied, failed, opted out). Requires campaigns:view.",
    {
      status: z
        .enum(["draft", "scheduled", "running", "paused", "completed", "canceled", "failed"])
        .optional()
        .describe("Filter by status"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        const params: Record<string, string> = {};
        if (args.status) params.status = args.status;
        return successResult(await client.get("/api/v1/campaigns", params));
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  server.tool(
    "crm_get_campaign",
    "Get a campaign (content, audience, schedule, pacing limits, safety settings, stats, timeline).",
    { campaignId: z.string().describe("Campaign ID") },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        return successResult(await client.get("/api/v1/campaigns/get", { campaignId: args.campaignId }));
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  server.tool(
    "crm_campaign_report",
    "Campaign report: counters, delivery/read/reply/failure/opt-out rates, error breakdown, estimated cost, progress and timeline.",
    { campaignId: z.string().describe("Campaign ID") },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        return successResult(await client.get("/api/v1/campaigns/report", { campaignId: args.campaignId }));
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  server.tool(
    "crm_create_campaign",
    "Create a DRAFT WhatsApp campaign. Never launches: launching requires human acknowledgements (LGPD consent, bridge ban risk) via crm_launch_campaign or the app. Text campaigns: give 2+ variants (rotated) and use {{nome}} placeholders; Meta channels reaching new numbers need an approved template (content.kind = 'template'). Requires campaigns:manage.",
    {
      name: z.string().describe("Campaign name"),
      channelConfigId: z.string().describe("WhatsApp channel (Meta or bridge) — see the app's Channels settings"),
      description: z.string().optional(),
      content: z
        .object({
          kind: z.enum(["text", "template"]),
          variants: z
            .array(z.object({ text: z.string(), attachmentFileIds: z.array(z.string()).optional() }))
            .describe("Message variants (text; spintax {a|b}; {{nome}} vars)"),
          contentType: z.enum(["text", "image", "file", "audio"]).optional(),
          template: z
            .object({
              name: z.string(),
              language: z.string(),
              category: z.string().optional(),
              headerFileId: z.string().optional(),
              headerFormat: z.string().optional(),
              bodyParams: z.array(z.object({ source: z.enum(["field", "const"]), value: z.string() })).optional(),
              bodyText: z.string().optional(),
            })
            .optional(),
        })
        .describe("Message content"),
      audience: z
        .object({
          source: z
            .enum(["segment", "import", "manual", "groups", "group_members"])
            .describe(
              "'groups' posts in the WhatsApp GROUPS themselves (one recipient per room); 'group_members' direct-messages the members of those rooms one by one (bridge channels only)"
            ),
          filters: audienceFilters.optional(),
          groupChatIds: z
            .array(z.string())
            .optional()
            .describe("Monitored groups of the SAME channel (source 'groups' or 'group_members')"),
          memberFilters: memberFilters.optional(),
          targetBoardId: z.string().optional().describe("Board where NEW numbers become leads"),
          targetStageId: z.string().optional(),
          targetTags: z.array(z.string()).optional(),
        })
        .describe("Audience definition; manual/import recipients are added with crm_add_campaign_recipients"),
      schedule: z
        .object({
          startAt: z.number().optional(),
          timezone: z.string(),
          windowStartHour: z.number(),
          windowEndHour: z.number(),
          days: z.array(z.number()),
        })
        .optional()
        .describe("Sending window (default 09–20h Mon–Fri in the org timezone)"),
      pacing: z
        .object({
          minDelaySec: z.number(),
          maxDelaySec: z.number(),
          batchSize: z.number(),
          batchPauseMin: z.number(),
          maxPerHour: z.number(),
          maxPerDay: z.number(),
          maxNewContactsPerDay: z.number().optional(),
          respectWarmup: z.boolean().optional(),
        })
        .optional()
        .describe("Sending limits (omit to use the safe defaults for the channel; hard caps are always enforced)"),
      safety: z
        .object({
          checkNumbersFirst: z.boolean().optional(),
          allowLinks: z.boolean().optional(),
          stopOnReplyRateBelow: z.number().nullable().optional(),
          stopOnDeliveryRateBelow: z.number().nullable().optional(),
          maxConsecutiveFailures: z.number().optional(),
        })
        .optional(),
    },
    { destructiveHint: false },
    async (args) => {
      try {
        return successResult(await client.post("/api/v1/campaigns/create", args));
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  server.tool(
    "crm_add_campaign_recipients",
    "Add recipients to a DRAFT campaign: either `entries` (up to 500 phone numbers with optional name/vars) or a `csv` text (≤5 MB) with a column `mapping`. With csv, set dryRun=true first to validate (returns valid/invalid/duplicates/suppressed counts). Phones are normalized to E.164 (default country 55). Suppressed (opted-out) numbers are never added.",
    {
      campaignId: z.string(),
      sourceGroupChatId: z
        .string()
        .optional()
        .describe("Group these numbers came from (kept for the per-group report)"),
      entries: z
        .array(
          z.object({
            phone: z.string(),
            name: z.string().optional(),
            vars: z.record(z.string()).optional().describe("Values for {{placeholders}}"),
          }),
        )
        .max(500)
        .optional(),
      csv: z.string().optional().describe("CSV text with a header row"),
      fileId: z.string().optional().describe("Uploaded file id (fileType import_file) instead of csv text"),
      mapping: z
        .object({
          phone: z.string().describe("Header of the phone column"),
          name: z.string().optional(),
          email: z.string().optional(),
          company: z.string().optional(),
          varsColumns: z.array(z.string()).optional().describe("Extra columns exposed as {{column}} vars"),
        })
        .optional(),
      dryRun: z.boolean().optional(),
    },
    { destructiveHint: false },
    async (args) => {
      try {
        return successResult(await client.post("/api/v1/campaigns/recipients", args));
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  server.tool(
    "crm_launch_campaign",
    "Launch a draft campaign. REQUIRES explicit acknowledgements from the human operator you act for: consentAck=true (the organization has consent / legal basis to contact the list — LGPD) and, on bridge (unofficial) channels, bridgeRiskAck=true (the number can be permanently banned). If the bridge number was connected less than 3 days ago (safe-defaults returns newNumberRisk), newNumberRiskAck=true is also required — the most-banned pattern; warned, not blocked. Campaigns whose audience is 'group_members' also require groupMembersDmAck=true. Limits above the safe defaults additionally require overrideAck=true and overrideWord='ENTENDO'. Requires campaigns:full. Never set these flags without the human's explicit confirmation.",
    {
      campaignId: z.string(),
      consentAck: z.boolean().describe("Human confirmed consent/legal basis for the list"),
      bridgeRiskAck: z.boolean().optional().describe("Human accepted the ban risk (bridge channels)"),
      newNumberRiskAck: z.boolean().optional().describe("Human accepted launching from a bridge number connected less than 3 days ago"),
      groupMembersDmAck: z
        .boolean()
        .optional()
        .describe(
          "REQUIRED for audience.source = 'group_members': the human accepted direct-messaging people who never started a conversation with the business — the most blocked pattern on WhatsApp"
        ),
      overrideAck: z.boolean().optional(),
      overrideWord: z.string().optional().describe("Type ENTENDO to launch above safe limits"),
      tierAtLaunch: z.string().optional().describe("Meta portfolio tier (from crm_get_whatsapp_tier)"),
    },
    { destructiveHint: true },
    async (args) => {
      try {
        return successResult(await client.post("/api/v1/campaigns/launch", args));
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  server.tool(
    "crm_pause_campaign",
    "Pause a running campaign (sending stops immediately; it can be resumed).",
    { campaignId: z.string(), reason: z.string().optional() },
    { destructiveHint: false },
    async (args) => {
      try {
        return successResult(await client.post("/api/v1/campaigns/pause", args));
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  server.tool(
    "crm_resume_campaign",
    "Resume a paused campaign.",
    { campaignId: z.string() },
    { destructiveHint: false },
    async (args) => {
      try {
        return successResult(await client.post("/api/v1/campaigns/resume", args));
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  server.tool(
    "crm_cancel_campaign",
    "Cancel a running/paused campaign. Pending recipients are skipped; cannot be undone. Requires campaigns:full.",
    { campaignId: z.string() },
    { destructiveHint: true },
    async (args) => {
      try {
        return successResult(await client.post("/api/v1/campaigns/cancel", args));
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  server.tool(
    "crm_list_opt_outs",
    "List the organization's suppression list (numbers that must never receive campaigns: inbound STOP keywords, Meta 131050, manual). Requires campaigns:view.",
    {
      search: z.string().optional().describe("Digits to search in the phone"),
      limit: z.number().optional(),
      cursor: z.string().optional(),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        const params: Record<string, string> = {};
        if (args.search) params.search = args.search;
        if (args.limit) params.limit = String(args.limit);
        if (args.cursor) params.cursor = args.cursor;
        return successResult(await client.get("/api/v1/opt-outs", params));
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  server.tool(
    "crm_add_opt_out",
    "Add a phone (or a contact's phone) to the suppression list — the number will never receive campaigns again. Use when a customer asks not to be contacted. Requires campaigns:manage.",
    {
      phone: z.string().optional(),
      contactId: z.string().optional(),
      reason: z.string().optional(),
    },
    { destructiveHint: false },
    async (args) => {
      try {
        return successResult(await client.post("/api/v1/opt-outs", args));
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  server.tool(
    "crm_list_whatsapp_templates",
    "List the Meta (Cloud API) message templates cached for a channel (name, language, category, status, quality, body text, buttons). Only APPROVED templates can be used in campaigns to new numbers. Requires campaigns:view.",
    { channelConfigId: z.string(), onlyApproved: z.boolean().optional() },
    { readOnlyHint: true, destructiveHint: false },
    async (args) => {
      try {
        const params: Record<string, string> = { channelConfigId: args.channelConfigId };
        if (args.onlyApproved) params.onlyApproved = "true";
        return successResult(await client.get("/api/v1/whatsapp/templates", params));
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );
}
