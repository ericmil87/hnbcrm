import { getAuthUserId } from "@convex-dev/auth/server";
import { QueryCtx, MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";

export async function requireAuth(ctx: QueryCtx | MutationCtx, organizationId: Id<"organizations">) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  const userMember = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_user", (q) =>
      q.eq("organizationId", organizationId).eq("userId", userId)
    )
    .first();
  if (!userMember) throw new Error("Not authorized");
  return userMember;
}
