/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as apiKeys from "../apiKeys.js";
import type * as auth from "../auth.js";
import type * as boards from "../boards.js";
import type * as contacts from "../contacts.js";
import type * as conversations from "../conversations.js";
import type * as handoffs from "../handoffs.js";
import type * as http from "../http.js";
import type * as leads from "../leads.js";
import type * as organizations from "../organizations.js";
import type * as router from "../router.js";
import type * as teamMembers from "../teamMembers.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  apiKeys: typeof apiKeys;
  auth: typeof auth;
  boards: typeof boards;
  contacts: typeof contacts;
  conversations: typeof conversations;
  handoffs: typeof handoffs;
  http: typeof http;
  leads: typeof leads;
  organizations: typeof organizations;
  router: typeof router;
  teamMembers: typeof teamMembers;
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
