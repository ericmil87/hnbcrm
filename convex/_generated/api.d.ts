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
import type * as boards from "../boards.js";
import type * as contacts from "../contacts.js";
import type * as conversations from "../conversations.js";
import type * as dashboard from "../dashboard.js";
import type * as fieldDefinitions from "../fieldDefinitions.js";
import type * as handoffs from "../handoffs.js";
import type * as http from "../http.js";
import type * as leadSources from "../leadSources.js";
import type * as leads from "../leads.js";
import type * as lib_auditDescription from "../lib/auditDescription.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_batchGet from "../lib/batchGet.js";
import type * as llmsTxt from "../llmsTxt.js";
import type * as nodeActions from "../nodeActions.js";
import type * as onboarding from "../onboarding.js";
import type * as onboardingSeed from "../onboardingSeed.js";
import type * as openapiSpec from "../openapiSpec.js";
import type * as organizations from "../organizations.js";
import type * as router from "../router.js";
import type * as savedViews from "../savedViews.js";
import type * as seed from "../seed.js";
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
  boards: typeof boards;
  contacts: typeof contacts;
  conversations: typeof conversations;
  dashboard: typeof dashboard;
  fieldDefinitions: typeof fieldDefinitions;
  handoffs: typeof handoffs;
  http: typeof http;
  leadSources: typeof leadSources;
  leads: typeof leads;
  "lib/auditDescription": typeof lib_auditDescription;
  "lib/auth": typeof lib_auth;
  "lib/batchGet": typeof lib_batchGet;
  llmsTxt: typeof llmsTxt;
  nodeActions: typeof nodeActions;
  onboarding: typeof onboarding;
  onboardingSeed: typeof onboardingSeed;
  openapiSpec: typeof openapiSpec;
  organizations: typeof organizations;
  router: typeof router;
  savedViews: typeof savedViews;
  seed: typeof seed;
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

export declare const components: {};
