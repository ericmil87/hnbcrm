// Disparo dos e-mails de autenticação (redefinir senha, boas-vindas). Os
// dois são fora do circuito de notificações normal: não passam por
// notificationPreferences — um é segurança da conta (código de acesso), o
// outro é o primeiro contato com o produto — nenhum dos dois é algo que o
// membro deveria conseguir desligar como uma notificação de produto.
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { sendTransactionalEmail } from "./email";
import { buildPasswordResetTemplate, buildWelcomeTemplate } from "./authEmailTemplates";
import { RESET_CODE_TTL_MINUTES } from "./lib/passwordResetConfig";
import { appUrl } from "./lib/appUrl";
import { maskEmailForLog, normalizeEmail } from "./lib/emailAddress";

// 5 códigos por hora por endereço: folga para quem erra e pede de novo, teto
// para quem usa o formulário público como canhão de e-mail.
export const RESET_EMAILS_PER_WINDOW = 5;
const RESET_EMAIL_WINDOW_MS = 60 * 60 * 1000;

// Chamado pelo provider de reset (convex/passwordReset.ts) via
// ctx.runMutation. NUNCA logar `code` nem `email` inteiros — quem lê o log
// do deployment não deveria conseguir sequestrar a conta de ninguém.
export const sendPasswordResetCode = internalMutation({
  args: {
    email: v.string(),
    code: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Janela fixa por endereço. Estourou = silêncio (o código novo já foi
    // gravado pelo Convex Auth, mas não sai): para quem pede, a tela mostra a
    // mesma mensagem neutra de sempre; para o alvo de um ataque, a caixa para
    // de encher.
    const email = normalizeEmail(args.email);
    const now = Date.now();
    const throttle = await ctx.db
      .query("authEmailThrottle")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (!throttle) {
      await ctx.db.insert("authEmailThrottle", { email, windowStart: now, count: 1 });
    } else if (now - throttle.windowStart >= RESET_EMAIL_WINDOW_MS) {
      await ctx.db.patch(throttle._id, { windowStart: now, count: 1 });
    } else if (throttle.count >= RESET_EMAILS_PER_WINDOW) {
      console.warn(`[email] passwordReset: teto de pedidos atingido para ${maskEmailForLog(email)}`);
      return null;
    } else {
      await ctx.db.patch(throttle._id, { count: throttle.count + 1 });
    }

    const template = buildPasswordResetTemplate({
      code: args.code,
      expiresMinutes: RESET_CODE_TTL_MINUTES,
    });
    await sendTransactionalEmail(ctx, {
      to: args.email,
      subject: template.subject,
      html: template.html,
      kind: "passwordReset",
    });
    return null;
  },
});

// Agendado por organizations.ts → createOrganization logo após criar o
// teamMember admin. Confere organizationId do membro contra o arg (mesma
// defesa em profundidade multi-tenant de email.ts → dispatchNotification)
// e só envia se houver e-mail cadastrado.
export const sendWelcomeEmail = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await ctx.db.get(args.teamMemberId);
    if (!member || member.organizationId !== args.organizationId || !member.email) {
      return null;
    }

    const org = await ctx.db.get(args.organizationId);
    if (!org) return null;

    const template = buildWelcomeTemplate({
      memberName: member.name,
      orgName: org.name,
      appUrl: appUrl(),
    });
    await sendTransactionalEmail(ctx, {
      to: member.email,
      subject: template.subject,
      html: template.html,
      kind: "welcome",
    });
    return null;
  },
});
