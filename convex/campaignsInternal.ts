/**
 * Campanhas — wrappers INTERNOS (sem sessão) para a REST API (`router.ts`),
 * o copiloto e o MCP. Cada um recebe `actorMemberId` (o teamMember da API
 * key ou o humano dono da sessão do copiloto) e delega ao MESMO handler da
 * função pública em `campaigns.ts` / `optOuts.ts` / `whatsappTemplates.ts` —
 * as regras (RBAC via `lib/campaignAuth.ts`, multi-tenant, validações,
 * auditoria) são exatamente as da UI. `via` marca a auditoria ("api" | "copilot").
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import {
  listCampaignsArgs,
  listCampaignsHandler,
  getCampaignArgs,
  getCampaignHandler,
  getSafeDefaultsArgs,
  getSafeDefaultsHandler,
  getCampaignRecipientsArgs,
  getCampaignRecipientsHandler,
  getCampaignReportArgs,
  getCampaignReportHandler,
  previewAudienceArgs,
  previewAudienceHandler,
  createCampaignArgs,
  createCampaignHandler,
  updateCampaignArgs,
  updateCampaignHandler,
  deleteCampaignArgs,
  deleteCampaignHandler,
  addManualRecipientsArgs,
  addManualRecipientsHandler,
  importRecipientsCsvArgs,
  importRecipientsCsvHandler,
  launchCampaignArgs,
  launchCampaignHandler,
  pauseCampaignArgs,
  pauseCampaignHandler,
  resumeCampaignArgs,
  resumeCampaignHandler,
  cancelCampaignArgs,
  cancelCampaignHandler,
  retryFailedArgs,
  retryFailedHandler,
} from "./campaigns";
import {
  listOptOutsArgs,
  listOptOutsHandler,
  addOptOutArgs,
  addOptOutHandler,
  removeOptOutArgs,
  removeOptOutHandler,
} from "./optOuts";
import {
  listTemplatesArgs,
  listTemplatesHandler,
  syncMetaTemplatesArgs,
  syncMetaTemplatesHandler,
  readMetaTierArgs,
  readMetaTierHandler,
} from "./whatsappTemplates";

const actor = {
  actorMemberId: v.id("teamMembers"),
  via: v.optional(v.string()),
};

// ── Leitura ──
export const internalListCampaigns = internalQuery({
  args: { ...listCampaignsArgs, ...actor },
  returns: v.any(),
  handler: listCampaignsHandler,
});
export const internalGetCampaign = internalQuery({
  args: { ...getCampaignArgs, ...actor },
  returns: v.any(),
  handler: getCampaignHandler,
});
export const internalGetSafeDefaults = internalQuery({
  args: { ...getSafeDefaultsArgs, ...actor },
  returns: v.any(),
  handler: getSafeDefaultsHandler,
});
export const internalGetCampaignRecipients = internalQuery({
  args: { ...getCampaignRecipientsArgs, ...actor },
  returns: v.any(),
  handler: getCampaignRecipientsHandler,
});
export const internalGetCampaignReport = internalQuery({
  args: { ...getCampaignReportArgs, ...actor },
  returns: v.any(),
  handler: getCampaignReportHandler,
});
export const internalPreviewAudience = internalQuery({
  args: { ...previewAudienceArgs, ...actor },
  returns: v.any(),
  handler: previewAudienceHandler,
});

// ── Escrita ──
export const internalCreateCampaign = internalMutation({
  args: { ...createCampaignArgs, ...actor },
  returns: v.id("campaigns"),
  handler: createCampaignHandler,
});
export const internalUpdateCampaign = internalMutation({
  args: { ...updateCampaignArgs, ...actor },
  returns: v.null(),
  handler: updateCampaignHandler,
});
export const internalDeleteCampaign = internalMutation({
  args: { ...deleteCampaignArgs, ...actor },
  returns: v.null(),
  handler: deleteCampaignHandler,
});
export const internalAddManualRecipients = internalMutation({
  args: { ...addManualRecipientsArgs, ...actor },
  returns: v.any(),
  handler: addManualRecipientsHandler,
});
export const internalImportRecipientsCsv = internalAction({
  args: { ...importRecipientsCsvArgs, ...actor },
  returns: v.any(),
  handler: importRecipientsCsvHandler,
});
export const internalLaunchCampaign = internalMutation({
  args: { ...launchCampaignArgs, ...actor },
  returns: v.object({ status: v.string(), warnings: v.array(v.string()), estimatedCostUsd: v.number() }),
  handler: launchCampaignHandler,
});
export const internalPauseCampaign = internalMutation({
  args: { ...pauseCampaignArgs, ...actor },
  returns: v.null(),
  handler: pauseCampaignHandler,
});
export const internalResumeCampaign = internalMutation({
  args: { ...resumeCampaignArgs, ...actor },
  returns: v.null(),
  handler: resumeCampaignHandler,
});
export const internalCancelCampaign = internalMutation({
  args: { ...cancelCampaignArgs, ...actor },
  returns: v.null(),
  handler: cancelCampaignHandler,
});
export const internalRetryFailed = internalMutation({
  args: { ...retryFailedArgs, ...actor },
  returns: v.object({ requeued: v.number() }),
  handler: retryFailedHandler,
});

// ── Supressão (opt-out) ──
export const internalListOptOuts = internalQuery({
  args: { ...listOptOutsArgs, ...actor },
  returns: v.any(),
  handler: listOptOutsHandler,
});
export const internalAddOptOut = internalMutation({
  args: { ...addOptOutArgs, ...actor },
  returns: v.union(v.id("optOuts"), v.null()),
  handler: addOptOutHandler,
});
export const internalRemoveOptOut = internalMutation({
  args: { ...removeOptOutArgs, ...actor },
  returns: v.null(),
  handler: removeOptOutHandler,
});

// ── Templates Meta ──
export const internalListTemplates = internalQuery({
  args: { ...listTemplatesArgs, ...actor },
  returns: v.any(),
  handler: listTemplatesHandler,
});
export const internalSyncMetaTemplates = internalAction({
  args: { ...syncMetaTemplatesArgs, ...actor },
  returns: v.object({ synced: v.number(), removed: v.number(), approved: v.number() }),
  handler: syncMetaTemplatesHandler,
});
export const internalReadMetaTier = internalAction({
  args: { ...readMetaTierArgs, ...actor },
  returns: v.object({ tier: v.string(), limit: v.union(v.number(), v.null()) }),
  handler: readMetaTierHandler,
});
