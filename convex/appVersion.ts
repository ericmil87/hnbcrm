import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Minimum client build the app accepts (env `MIN_CLIENT_BUILD`, e.g. "0.80.0"; unset = no minimum).
 *
 * Intentionally PUBLIC and WITHOUT auth: it is a non-sensitive release number, and the client must be able
 * to read it before sign-in (a stale bundle may be unable to authenticate). Never put anything else here.
 */
export const getMinClientBuild = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async () => {
    const raw = process.env.MIN_CLIENT_BUILD?.trim();
    return raw ? raw : null;
  },
});
