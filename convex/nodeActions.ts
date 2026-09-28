"use node";

import crypto from "crypto";
import { v } from "convex/values";
import { internalAction, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { permissionsValidator } from "./schema";
import { appUrl as resolveAppUrl } from "./lib/appUrl";
import { hasEmailShape, normalizeEmail } from "./lib/emailAddress";

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

// Invite a human team member — creates auth account with temp password if user is new.
// Três desfechos (para a tela): conta nova (`isNewUser` + `tempPassword`),
// pessoa que JÁ tinha conta (`existingUser`, senha intacta, e-mail "você foi
// adicionado") e membro removido reativado (`reactivated`).
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
    existingUser: v.boolean(),
    reactivated: v.boolean(),
    pendingPasswordChange: v.boolean(),
    tempPassword: v.optional(v.string()),
    emailSent: v.boolean(),
  }),
  handler: async (ctx, args): Promise<{
    teamMemberId: Id<"teamMembers">;
    isNewUser: boolean;
    existingUser: boolean;
    reactivated: boolean;
    pendingPasswordChange: boolean;
    tempPassword?: string;
    emailSent: boolean;
  }> => {
    // Antes de QUALQUER escrita: o banco já tem membro com e-mail "toni" e
    // "oli@milfont.netdd" — conta criada com endereço impossível não recebe
    // convite nem consegue recuperar a senha depois.
    if (!hasEmailShape(args.email)) {
      throw new Error("E-mail inválido. Confira o endereço e tente de novo.");
    }
    const email = normalizeEmail(args.email);

    // team:manage + cargo/permissões dentro das do convidante + "já é membro"
    // — tudo ANTES de criar conta (action não é transacional).
    const { callerMemberId } = await ctx.runQuery(internal.teamMembers.internalPrepareInvite, {
      organizationId: args.organizationId,
      email: args.email,
      role: args.role,
      permissions: args.permissions,
    });

    let isNewUser = false;
    let userId: Id<"users">;
    let tempPassword: string | undefined;

    // Conta existente em QUALQUER caixa (inclusive legado "Eric@X.com"): o
    // e-mail vai cru — normalizado aqui, a forma digitada exata se perderia
    // na escolha entre variantes.
    const existingUser: any = await ctx.runQuery(
      internal.authHelpers.queryUserByEmail,
      { email: args.email }
    );

    let memberName = args.name;
    if (existingUser) {
      userId = existingUser._id;
      // A pessoa já tem nome na conta; o assistente manda o e-mail (ou o
      // começo dele) como nome quando o admin não digita nenhum.
      if (typeof existingUser.name === "string" && existingUser.name.trim()) {
        memberName = existingUser.name.trim();
      }
    } else {
      const { Scrypt } = await import("lucia");
      const scrypt = new Scrypt();
      const candidatePassword = generateTempPassword();
      const passwordHash = await scrypt.hash(candidatePassword);

      // Idempotente: se outro convite criou a conta no meio do caminho, volta
      // `created:false` e seguimos como usuário existente (sem senha).
      const inserted = await ctx.runMutation(internal.authHelpers.insertUserAndAuthAccount, {
        email: args.email,
        name: args.name,
        passwordHash,
      });
      userId = inserted.userId;
      if (inserted.created) {
        isNewUser = true;
        tempPassword = candidatePassword;
      }
    }

    // Conta existente ainda com senha temporária (convidada noutra org e sem
    // ter trocado): o vínculo novo herda o flag.
    const pendingPasswordChange =
      isNewUser ||
      (await ctx.runQuery(internal.teamMembers.internalUserMustChangePassword, { userId }));

    // Grava o vínculo sem duplicar: reativa removido, adota pendente legado.
    const { teamMemberId, outcome } = await ctx.runMutation(
      internal.teamMembers.internalUpsertInvitedMember,
      {
        organizationId: args.organizationId,
        userId,
        name: memberName,
        email,
        role: args.role,
        invitedBy: callerMemberId,
        mustChangePassword: pendingPasswordChange,
        permissions: args.permissions,
      }
    );

    // Action não é transacional: usuário, conta e membro JÁ estão gravados, e a
    // senha em claro só existe aqui. Se o e-mail lançasse, o `return` abaixo
    // nunca rodava, a senha se perdia e reconvidar era recusado ("já é membro")
    // — um membro-zumbi sem credencial. Por isso nada aqui pode lançar, e
    // `emailSent` diz à tela se ela precisa mandar o admin copiar a senha.
    let emailSent = false;
    try {
      if (isNewUser && tempPassword) {
        const org = await ctx.runQuery(internal.organizations.internalGetOrganization, {
          organizationId: args.organizationId,
        });
        emailSent = await ctx.runMutation(internal.email.dispatchNotification, {
          organizationId: args.organizationId,
          recipientMemberId: teamMemberId,
          eventType: "invite",
          templateData: {
            memberName,
            orgName: org?.name ?? "HNBCRM",
            email,
            tempPassword,
            loginUrl: `${resolveAppUrl()}/entrar`,
          },
        });
      } else {
        emailSent = await ctx.runMutation(internal.authEmails.sendAddedToOrgEmail, {
          organizationId: args.organizationId,
          teamMemberId,
          invitedByMemberId: callerMemberId,
          pendingPasswordChange,
        });
      }
    } catch (error) {
      console.error("[invite] falha ao enviar o e-mail de convite:", error instanceof Error ? error.message : String(error));
    }

    return {
      teamMemberId,
      isNewUser,
      existingUser: !isNewUser,
      reactivated: outcome === "reactivated",
      // Conta existente que AINDA está com a senha temporária de outro convite:
      // a tela não pode dizer "entre com a senha de sempre".
      pendingPasswordChange,
      tempPassword: isNewUser ? tempPassword : undefined,
      emailSent,
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

    // A senha é da conta: limpa o flag em TODOS os membros do usuário, não
    // só no da org em que a troca foi feita.
    if (authAccount.userId) {
      await ctx.runMutation(internal.teamMembers.internalClearMustChangePasswordForUser, {
        userId: authAccount.userId,
      });
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

    // Retry with backoff; non-2xx responses count as failures (not only thrown errors)
    const MAX_ATTEMPTS = 3;
    const BACKOFF_MS = [0, 2000, 5000];

    for (const webhook of webhooks) {
      const body = JSON.stringify({
        event: args.event,
        timestamp: Date.now(),
        data: args.payload,
      });
      const signature = `sha256=${hmacSha256(body, webhook.secret)}`;

      let delivered = false;
      let lastFailure = "";

      for (let attempt = 0; attempt < MAX_ATTEMPTS && !delivered; attempt++) {
        if (BACKOFF_MS[attempt] > 0) {
          await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt]));
        }
        try {
          const response = await fetch(webhook.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Webhook-Signature": signature,
              "X-Webhook-Event": args.event,
            },
            body,
          });
          if (response.ok) {
            delivered = true;
          } else {
            lastFailure = `HTTP ${response.status}`;
          }
        } catch (error) {
          lastFailure = error instanceof Error ? error.message : String(error);
        }
      }

      if (delivered) {
        await ctx.runMutation(internal.webhookTrigger.updateWebhookTriggered, {
          webhookId: webhook._id,
        });
      } else {
        console.error(
          `Webhook "${webhook.name}" (${args.event}) failed after ${MAX_ATTEMPTS} attempts: ${lastFailure}`
        );
      }
    }

    return null;
  },
});
