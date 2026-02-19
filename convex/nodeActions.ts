"use node";

import crypto from "crypto";
import { v } from "convex/values";
import { internalAction, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { permissionsValidator } from "./schema";

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function hmacSha256(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function generateTempPassword(): string {
  // 12-char alphanumeric password
  return crypto.randomBytes(9).toString("base64url");
}

// Hash a string with SHA-256 (used by router to hash incoming API keys)
export const hashString = internalAction({
  args: { input: v.string() },
  returns: v.string(),
  handler: async (_ctx, args) => {
    return sha256(args.input);
  },
});

// Create API key with secure hashing (replaces old plaintext mutation)
export const createApiKey = action({
  args: {
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
    name: v.string(),
    expiresAt: v.optional(v.number()),
  },
  returns: v.object({ apiKeyId: v.id("apiKeys"), apiKey: v.string() }),
  handler: async (ctx, args): Promise<{ apiKeyId: Id<"apiKeys">; apiKey: string }> => {
    // Auth check via internal query (auth context propagates from action)
    const admin: any = await ctx.runQuery(internal.apiKeys.verifyAdmin, {
      organizationId: args.organizationId,
    });
    if (!admin) throw new Error("Not authorized — admin role required");

    // Generate cryptographically secure API key
    const apiKey = `hnbcrm_${crypto.randomBytes(24).toString("base64url")}`;
    const keyHash = sha256(apiKey);

    // Store only the hash
    const apiKeyId = await ctx.runMutation(internal.apiKeys.insertApiKey, {
      organizationId: args.organizationId,
      teamMemberId: args.teamMemberId,
      name: args.name,
      keyHash,
      actorId: admin._id,
      expiresAt: args.expiresAt,
    });

    return { apiKeyId, apiKey };
  },
});

// Invite a human team member — creates auth account with temp password if user is new
export const inviteHumanMember = action({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    email: v.string(),
    role: v.union(v.literal("admin"), v.literal("manager"), v.literal("agent")),
    permissions: v.optional(permissionsValidator),
  },
  returns: v.object({
    teamMemberId: v.id("teamMembers"),
    isNewUser: v.boolean(),
    tempPassword: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<{
    teamMemberId: Id<"teamMembers">;
    isNewUser: boolean;
    tempPassword?: string;
  }> => {
    // Verify caller has team:manage
    const callerMember: any = await ctx.runQuery(
      internal.teamMembers.internalVerifyTeamManager,
      { organizationId: args.organizationId }
    );
    if (!callerMember) throw new Error("Permissão insuficiente");

    let isNewUser = false;
    let userId: Id<"users"> | undefined;
    let tempPassword: string | undefined;

    const { Scrypt } = await import("lucia");
    const scrypt = new Scrypt();

    // Look for existing user in the auth system
    const existingUser: any = await ctx.runQuery(
      internal.authHelpers.queryUserByEmail,
      { email: args.email }
    );

    if (existingUser) {
      userId = existingUser._id;
      isNewUser = false;

      // Check if already a member of this org
      const existingMember: any = await ctx.runQuery(
        internal.teamMembers.internalGetMemberByUserId,
        { organizationId: args.organizationId, userId: userId! }
      );
      if (existingMember) {
        throw new Error("Este usuário já é membro desta organização");
      }
    } else {
      // Create new user + auth account with temp password
      isNewUser = true;
      tempPassword = generateTempPassword();
      const passwordHash = await scrypt.hash(tempPassword);

      // Create user record + auth account
      userId = await ctx.runMutation(internal.authHelpers.insertUserAndAuthAccount, {
        email: args.email,
        name: args.name,
        passwordHash,
      });
    }

    // Create the team member record
    const teamMemberId = await ctx.runMutation(
      internal.teamMembers.internalCreateInvitedMember,
      {
        organizationId: args.organizationId,
        userId,
        name: args.name,
        email: args.email,
        role: args.role,
        invitedBy: callerMember._id,
        mustChangePassword: isNewUser,
        permissions: args.permissions,
      }
    );

    // Send invite email for new users
    if (isNewUser && tempPassword) {
      const org = await ctx.runQuery(internal.organizations.internalGetOrganization, {
        organizationId: args.organizationId,
      });
      await ctx.runMutation(internal.email.dispatchNotification, {
        organizationId: args.organizationId,
        recipientMemberId: teamMemberId,
        eventType: "invite",
        templateData: {
          memberName: args.name,
          orgName: org?.name ?? "HNBCRM",
          email: args.email,
          tempPassword,
          loginUrl: `${process.env.APP_URL ?? "https://app.hnbcrm.com.br"}/entrar`,
        },
      });
    }

    return {
      teamMemberId,
      isNewUser,
      tempPassword: isNewUser ? tempPassword : undefined,
    };
  },
});

// Change password — validates current password first
export const changePassword = action({
  args: {
    organizationId: v.id("organizations"),
    currentPassword: v.string(),
    newPassword: v.string(),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args): Promise<{ success: boolean }> => {
    const { Scrypt } = await import("lucia");
    const scrypt = new Scrypt();

    // Get auth account for the current authenticated user
    const authAccount: any = await ctx.runQuery(
      internal.authHelpers.queryAuthAccountForCurrentUser,
      {}
    );

    if (!authAccount) throw new Error("Conta não encontrada");

    // Verify current password
    const valid = await scrypt.verify(authAccount.secret, args.currentPassword);
    if (!valid) throw new Error("Senha atual incorreta");

    // Hash new password and update
    const newHash = await scrypt.hash(args.newPassword);
    await ctx.runMutation(internal.authHelpers.patchAuthAccountSecret, {
      authAccountId: authAccount._id,
      newSecret: newHash,
    });

    // Clear mustChangePassword flag if set on any team member
    if (authAccount.userId) {
      const member: any = await ctx.runQuery(
        internal.teamMembers.internalGetMemberByUserId,
        { organizationId: args.organizationId, userId: authAccount.userId }
      );
      if (member?.mustChangePassword) {
        await ctx.runMutation(
          internal.teamMembers.internalClearMustChangePassword,
          { teamMemberId: member._id }
        );
      }
    }

    return { success: true };
  },
});

// Fire matching webhooks with HMAC-SHA256 signatures
export const triggerWebhooks = internalAction({
  args: {
    organizationId: v.id("organizations"),
    event: v.string(),
    payload: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const webhooks = await ctx.runQuery(internal.webhookTrigger.getMatchingWebhooks, {
      organizationId: args.organizationId,
      event: args.event,
    });

    for (const webhook of webhooks) {
      try {
        const body = JSON.stringify({
          event: args.event,
          timestamp: Date.now(),
          data: args.payload,
        });

        const signature = `sha256=${hmacSha256(body, webhook.secret)}`;

        await fetch(webhook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": signature,
            "X-Webhook-Event": args.event,
          },
          body,
        });

        await ctx.runMutation(internal.webhookTrigger.updateWebhookTriggered, {
          webhookId: webhook._id,
        });
      } catch (error) {
        console.error(`Failed to trigger webhook ${webhook.name}:`, error);
      }
    }

    return null;
  },
});
