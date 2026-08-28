/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as activities from "../activities.js";
import type * as agentEvals from "../agentEvals.js";
import type * as agentRuns from "../agentRuns.js";
import type * as aiDiagnostics from "../aiDiagnostics.js";
import type * as aiSettings from "../aiSettings.js";
import type * as apiKeys from "../apiKeys.js";
import type * as attendant from "../attendant.js";
import type * as auditLogs from "../auditLogs.js";
import type * as auth from "../auth.js";
import type * as authHelpers from "../authHelpers.js";
import type * as boards from "../boards.js";
import type * as bridge from "../bridge.js";
import type * as calendar from "../calendar.js";
import type * as channelConfigs from "../channelConfigs.js";
import type * as contacts from "../contacts.js";
import type * as conversations from "../conversations.js";
import type * as copilot from "../copilot.js";
import type * as copilotHttp from "../copilotHttp.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as email from "../email.js";
import type * as emailTemplates from "../emailTemplates.js";
import type * as embedScript from "../embedScript.js";
import type * as exports from "../exports.js";
import type * as fieldDefinitions from "../fieldDefinitions.js";
import type * as files from "../files.js";
import type * as formExperiments from "../formExperiments.js";
import type * as formPartials from "../formPartials.js";
import type * as formSubmissions from "../formSubmissions.js";
import type * as forms from "../forms.js";
import type * as handoffs from "../handoffs.js";
import type * as http from "../http.js";
import type * as importRun from "../importRun.js";
import type * as imports from "../imports.js";
import type * as leadSources from "../leadSources.js";
import type * as leads from "../leads.js";
import type * as lib_agentPersonas from "../lib/agentPersonas.js";
import type * as lib_agentRoutes from "../lib/agentRoutes.js";
import type * as lib_agentSecurity from "../lib/agentSecurity.js";
import type * as lib_agentTools from "../lib/agentTools.js";
import type * as lib_auditDescription from "../lib/auditDescription.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_batchGet from "../lib/batchGet.js";
import type * as lib_bridgeMedia from "../lib/bridgeMedia.js";
import type * as lib_bridgeParse from "../lib/bridgeParse.js";
import type * as lib_bridgeSend from "../lib/bridgeSend.js";
import type * as lib_bridgeSession from "../lib/bridgeSession.js";
import type * as lib_channelResolve from "../lib/channelResolve.js";
import type * as lib_csv from "../lib/csv.js";
import type * as lib_cursor from "../lib/cursor.js";
import type * as lib_exportColumns from "../lib/exportColumns.js";
import type * as lib_exportSanitize from "../lib/exportSanitize.js";
import type * as lib_fileQuotas from "../lib/fileQuotas.js";
import type * as lib_fileRefs from "../lib/fileRefs.js";
import type * as lib_fileValidation from "../lib/fileValidation.js";
import type * as lib_formFieldTypes from "../lib/formFieldTypes.js";
import type * as lib_importKeys from "../lib/importKeys.js";
import type * as lib_importMapping from "../lib/importMapping.js";
import type * as lib_inboundRouting from "../lib/inboundRouting.js";
import type * as lib_leadCascade from "../lib/leadCascade.js";
import type * as lib_llm_index from "../lib/llm/index.js";
import type * as lib_llm_openaiCompatible from "../lib/llm/openaiCompatible.js";
import type * as lib_llm_registry from "../lib/llm/registry.js";
import type * as lib_llm_sanitize from "../lib/llm/sanitize.js";
import type * as lib_llm_types from "../lib/llm/types.js";
import type * as lib_mediaEnrichment from "../lib/mediaEnrichment.js";
import type * as lib_notify from "../lib/notify.js";
import type * as lib_outboundSideEffects from "../lib/outboundSideEffects.js";
import type * as lib_permissions from "../lib/permissions.js";
import type * as lib_promptEnvelope from "../lib/promptEnvelope.js";
import type * as lib_searchText from "../lib/searchText.js";
import type * as lib_secretCrypto from "../lib/secretCrypto.js";
import type * as lib_taskSearchText from "../lib/taskSearchText.js";
import type * as lib_whatsappDispatch from "../lib/whatsappDispatch.js";
import type * as lib_whatsappParse from "../lib/whatsappParse.js";
import type * as llmsTxt from "../llmsTxt.js";
import type * as nodeActions from "../nodeActions.js";
import type * as notificationPreferences from "../notificationPreferences.js";
import type * as notifications from "../notifications.js";
import type * as onboarding from "../onboarding.js";
import type * as onboardingSeed from "../onboardingSeed.js";
import type * as openapiSpec from "../openapiSpec.js";
import type * as orgSecrets from "../orgSecrets.js";
import type * as organizations from "../organizations.js";
import type * as quickReplies from "../quickReplies.js";
import type * as router from "../router.js";
import type * as savedViews from "../savedViews.js";
import type * as scheduledMessages from "../scheduledMessages.js";
import type * as seed from "../seed.js";
import type * as taskComments from "../taskComments.js";
import type * as taskLabels from "../taskLabels.js";
import type * as taskProjects from "../taskProjects.js";
import type * as tasks from "../tasks.js";
import type * as teamMembers from "../teamMembers.js";
import type * as testReset from "../testReset.js";
import type * as transcription from "../transcription.js";
import type * as vision from "../vision.js";
import type * as webhookTrigger from "../webhookTrigger.js";
import type * as webhooks from "../webhooks.js";
import type * as whatsapp from "../whatsapp.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  activities: typeof activities;
  agentEvals: typeof agentEvals;
  agentRuns: typeof agentRuns;
  aiDiagnostics: typeof aiDiagnostics;
  aiSettings: typeof aiSettings;
  apiKeys: typeof apiKeys;
  attendant: typeof attendant;
  auditLogs: typeof auditLogs;
  auth: typeof auth;
  authHelpers: typeof authHelpers;
  boards: typeof boards;
  bridge: typeof bridge;
  calendar: typeof calendar;
  channelConfigs: typeof channelConfigs;
  contacts: typeof contacts;
  conversations: typeof conversations;
  copilot: typeof copilot;
  copilotHttp: typeof copilotHttp;
  crons: typeof crons;
  dashboard: typeof dashboard;
  email: typeof email;
  emailTemplates: typeof emailTemplates;
  embedScript: typeof embedScript;
  exports: typeof exports;
  fieldDefinitions: typeof fieldDefinitions;
  files: typeof files;
  formExperiments: typeof formExperiments;
  formPartials: typeof formPartials;
  formSubmissions: typeof formSubmissions;
  forms: typeof forms;
  handoffs: typeof handoffs;
  http: typeof http;
  importRun: typeof importRun;
  imports: typeof imports;
  leadSources: typeof leadSources;
  leads: typeof leads;
  "lib/agentPersonas": typeof lib_agentPersonas;
  "lib/agentRoutes": typeof lib_agentRoutes;
  "lib/agentSecurity": typeof lib_agentSecurity;
  "lib/agentTools": typeof lib_agentTools;
  "lib/auditDescription": typeof lib_auditDescription;
  "lib/auth": typeof lib_auth;
  "lib/batchGet": typeof lib_batchGet;
  "lib/bridgeMedia": typeof lib_bridgeMedia;
  "lib/bridgeParse": typeof lib_bridgeParse;
  "lib/bridgeSend": typeof lib_bridgeSend;
  "lib/bridgeSession": typeof lib_bridgeSession;
  "lib/channelResolve": typeof lib_channelResolve;
  "lib/csv": typeof lib_csv;
  "lib/cursor": typeof lib_cursor;
  "lib/exportColumns": typeof lib_exportColumns;
  "lib/exportSanitize": typeof lib_exportSanitize;
  "lib/fileQuotas": typeof lib_fileQuotas;
  "lib/fileRefs": typeof lib_fileRefs;
  "lib/fileValidation": typeof lib_fileValidation;
  "lib/formFieldTypes": typeof lib_formFieldTypes;
  "lib/importKeys": typeof lib_importKeys;
  "lib/importMapping": typeof lib_importMapping;
  "lib/inboundRouting": typeof lib_inboundRouting;
  "lib/leadCascade": typeof lib_leadCascade;
  "lib/llm/index": typeof lib_llm_index;
  "lib/llm/openaiCompatible": typeof lib_llm_openaiCompatible;
  "lib/llm/registry": typeof lib_llm_registry;
  "lib/llm/sanitize": typeof lib_llm_sanitize;
  "lib/llm/types": typeof lib_llm_types;
  "lib/mediaEnrichment": typeof lib_mediaEnrichment;
  "lib/notify": typeof lib_notify;
  "lib/outboundSideEffects": typeof lib_outboundSideEffects;
  "lib/permissions": typeof lib_permissions;
  "lib/promptEnvelope": typeof lib_promptEnvelope;
  "lib/searchText": typeof lib_searchText;
  "lib/secretCrypto": typeof lib_secretCrypto;
  "lib/taskSearchText": typeof lib_taskSearchText;
  "lib/whatsappDispatch": typeof lib_whatsappDispatch;
  "lib/whatsappParse": typeof lib_whatsappParse;
  llmsTxt: typeof llmsTxt;
  nodeActions: typeof nodeActions;
  notificationPreferences: typeof notificationPreferences;
  notifications: typeof notifications;
  onboarding: typeof onboarding;
  onboardingSeed: typeof onboardingSeed;
  openapiSpec: typeof openapiSpec;
  orgSecrets: typeof orgSecrets;
  organizations: typeof organizations;
  quickReplies: typeof quickReplies;
  router: typeof router;
  savedViews: typeof savedViews;
  scheduledMessages: typeof scheduledMessages;
  seed: typeof seed;
  taskComments: typeof taskComments;
  taskLabels: typeof taskLabels;
  taskProjects: typeof taskProjects;
  tasks: typeof tasks;
  teamMembers: typeof teamMembers;
  testReset: typeof testReset;
  transcription: typeof transcription;
  vision: typeof vision;
  webhookTrigger: typeof webhookTrigger;
  webhooks: typeof webhooks;
  whatsapp: typeof whatsapp;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  resend: {
    lib: {
      cancelEmail: FunctionReference<
        "mutation",
        "internal",
        { emailId: string },
        null
      >;
      cleanupAbandonedEmails: FunctionReference<
        "mutation",
        "internal",
        { olderThan?: number },
        null
      >;
      cleanupOldEmails: FunctionReference<
        "mutation",
        "internal",
        { olderThan?: number },
        null
      >;
      createManualEmail: FunctionReference<
        "mutation",
        "internal",
        {
          from: string;
          headers?: Array<{ name: string; value: string }>;
          replyTo?: Array<string>;
          subject: string;
          to: Array<string> | string;
        },
        string
      >;
      get: FunctionReference<
        "query",
        "internal",
        { emailId: string },
        {
          bcc?: Array<string>;
          bounced?: boolean;
          cc?: Array<string>;
          clicked?: boolean;
          complained: boolean;
          createdAt: number;
          deliveryDelayed?: boolean;
          errorMessage?: string;
          failed?: boolean;
          finalizedAt: number;
          from: string;
          headers?: Array<{ name: string; value: string }>;
          html?: string;
          opened: boolean;
          replyTo: Array<string>;
          resendId?: string;
          segment: number;
          status:
            | "waiting"
            | "queued"
            | "cancelled"
            | "sent"
            | "delivered"
            | "delivery_delayed"
            | "bounced"
            | "failed";
          subject?: string;
          template?: {
            id: string;
            variables?: Record<string, string | number>;
          };
          text?: string;
          to: Array<string>;
        } | null
      >;
      getStatus: FunctionReference<
        "query",
        "internal",
        { emailId: string },
        {
          bounced: boolean;
          clicked: boolean;
          complained: boolean;
          deliveryDelayed: boolean;
          errorMessage: string | null;
          failed: boolean;
          opened: boolean;
          status:
            | "waiting"
            | "queued"
            | "cancelled"
            | "sent"
            | "delivered"
            | "delivery_delayed"
            | "bounced"
            | "failed";
        } | null
      >;
      handleEmailEvent: FunctionReference<
        "mutation",
        "internal",
        { event: any },
        null
      >;
      sendEmail: FunctionReference<
        "mutation",
        "internal",
        {
          bcc?: Array<string>;
          cc?: Array<string>;
          from: string;
          headers?: Array<{ name: string; value: string }>;
          html?: string;
          options: {
            apiKey: string;
            initialBackoffMs: number;
            onEmailEvent?: { fnHandle: string };
            retryAttempts: number;
            testMode: boolean;
          };
          replyTo?: Array<string>;
          subject?: string;
          template?: {
            id: string;
            variables?: Record<string, string | number>;
          };
          text?: string;
          to: Array<string>;
        },
        string
      >;
      updateManualEmail: FunctionReference<
        "mutation",
        "internal",
        {
          emailId: string;
          errorMessage?: string;
          resendId?: string;
          status:
            | "waiting"
            | "queued"
            | "cancelled"
            | "sent"
            | "delivered"
            | "delivery_delayed"
            | "bounced"
            | "failed";
        },
        null
      >;
    };
  };
};
