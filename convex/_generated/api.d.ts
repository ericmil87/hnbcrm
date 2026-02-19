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
import type * as apiKeys from "../apiKeys.js";
import type * as auditLogs from "../auditLogs.js";
import type * as auth from "../auth.js";
import type * as authHelpers from "../authHelpers.js";
import type * as boards from "../boards.js";
import type * as calendar from "../calendar.js";
import type * as contacts from "../contacts.js";
import type * as conversations from "../conversations.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as email from "../email.js";
import type * as emailTemplates from "../emailTemplates.js";
import type * as fieldDefinitions from "../fieldDefinitions.js";
import type * as files from "../files.js";
import type * as handoffs from "../handoffs.js";
import type * as http from "../http.js";
import type * as leadSources from "../leadSources.js";
import type * as leads from "../leads.js";
import type * as lib_auditDescription from "../lib/auditDescription.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_batchGet from "../lib/batchGet.js";
import type * as lib_cursor from "../lib/cursor.js";
import type * as lib_fileQuotas from "../lib/fileQuotas.js";
import type * as lib_fileValidation from "../lib/fileValidation.js";
import type * as lib_permissions from "../lib/permissions.js";
import type * as llmsTxt from "../llmsTxt.js";
import type * as nodeActions from "../nodeActions.js";
import type * as notificationPreferences from "../notificationPreferences.js";
import type * as onboarding from "../onboarding.js";
import type * as onboardingSeed from "../onboardingSeed.js";
import type * as openapiSpec from "../openapiSpec.js";
import type * as organizations from "../organizations.js";
import type * as router from "../router.js";
import type * as savedViews from "../savedViews.js";
import type * as seed from "../seed.js";
import type * as taskComments from "../taskComments.js";
import type * as tasks from "../tasks.js";
import type * as teamMembers from "../teamMembers.js";
import type * as webhookTrigger from "../webhookTrigger.js";
import type * as webhooks from "../webhooks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  activities: typeof activities;
  apiKeys: typeof apiKeys;
  auditLogs: typeof auditLogs;
  auth: typeof auth;
  authHelpers: typeof authHelpers;
  boards: typeof boards;
  calendar: typeof calendar;
  contacts: typeof contacts;
  conversations: typeof conversations;
  crons: typeof crons;
  dashboard: typeof dashboard;
  email: typeof email;
  emailTemplates: typeof emailTemplates;
  fieldDefinitions: typeof fieldDefinitions;
  files: typeof files;
  handoffs: typeof handoffs;
  http: typeof http;
  leadSources: typeof leadSources;
  leads: typeof leads;
  "lib/auditDescription": typeof lib_auditDescription;
  "lib/auth": typeof lib_auth;
  "lib/batchGet": typeof lib_batchGet;
  "lib/cursor": typeof lib_cursor;
  "lib/fileQuotas": typeof lib_fileQuotas;
  "lib/fileValidation": typeof lib_fileValidation;
  "lib/permissions": typeof lib_permissions;
  llmsTxt: typeof llmsTxt;
  nodeActions: typeof nodeActions;
  notificationPreferences: typeof notificationPreferences;
  onboarding: typeof onboarding;
  onboardingSeed: typeof onboardingSeed;
  openapiSpec: typeof openapiSpec;
  organizations: typeof organizations;
  router: typeof router;
  savedViews: typeof savedViews;
  seed: typeof seed;
  taskComments: typeof taskComments;
  tasks: typeof tasks;
  teamMembers: typeof teamMembers;
  webhookTrigger: typeof webhookTrigger;
  webhooks: typeof webhooks;
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
