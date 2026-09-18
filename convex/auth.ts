import { v } from "convex/values";
import { convexAuth, getAuthUserId } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { query } from "./_generated/server";
import { passwordResetProvider } from "./passwordReset";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password({ reset: passwordResetProvider }), Anonymous],
  callbacks: {
    async afterUserCreatedOrUpdated(ctx, { userId }) {
      const user = await ctx.db.get(userId);
      if (!user?.email) return;

      // Link any unlinked teamMembers records that match this user's email
      // Cast needed because auth callback ctx doesn't carry our full schema types
      const db = ctx.db as any;
      const unlinkedMembers = await db
        .query("teamMembers")
        .withIndex("by_email", (q: any) => q.eq("email", user.email))
        .collect();

      for (const member of unlinkedMembers) {
        if (!member.userId) {
          await db.patch(member._id, { userId });
        }
      }
    },
  },
});

export const loggedInUser = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }
    const user = await ctx.db.get("users", userId);
    if (!user) {
      return null;
    }
    return user;
  },
});
