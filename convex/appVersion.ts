import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Minimum client build the app accepts (env `MIN_CLIENT_BUILD`, e.g. "0.80.0"; unset = no minimum).
 *
 * Intentionally PUBLIC and WITHOUT auth: it is a non-sensitive release number, and the check must not depend
 * on membership or organization (the app reads it from the /app shell, in every state, including while the
 * session or the org is still loading). Never put anything else here. MIN_CLIENT_BUILD must only point at a
 * version that is already published, otherwise every client would be told to update to something that does not exist.
 */
export const getMinClientBuild = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async () => {
    const raw = process.env.MIN_CLIENT_BUILD?.trim();
    return raw ? raw : null;
  },
});
