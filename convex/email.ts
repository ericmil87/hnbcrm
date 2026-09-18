import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { Resend, vOnEmailEventArgs } from "@convex-dev/resend";
import { buildTemplate } from "./emailTemplates";
import { appUrl } from "./lib/appUrl";
import { isDeliverableEmail, maskEmailForLog, normalizeEmail } from "./lib/emailAddress";

// O default do componente é `testMode: true`, e nesse modo ele LANÇA para todo
// destinatário que não seja `@resend.dev`. Este arquivo passou meses sem desligar
// a flag: nenhum e-mail transacional saiu, e como 14 dos 15 call sites agendam o
// envio, o erro só aparecia no log do Convex. Agora o envio real é o padrão e o
// sandbox é opt-in (`RESEND_TEST_MODE=true` + destinatário `delivered@resend.dev`).
// `emailConfig.test.ts` quebra se o default voltar.
export function resendTestMode(): boolean {
  return process.env.RESEND_TEST_MODE === "true";
}

export const resend: Resend = new Resend(components.resend, {
  testMode: resendTestMode(),
  onEmailEvent: internal.email.handleEmailEvent,
});

const fromAddress = () => process.env.RESEND_FROM_EMAIL ?? "HNBCRM <noreply@mail.hnbcrm.com>";

// ── Porta de saída ÚNICA ──
// Todo e-mail transacional sai por aqui. NUNCA lança: e-mail é efeito colateral,
// e um throw aqui reverte a mutation de quem chamou (no convite, isso engolia a
// senha temporária que só existia na memória da action). Devolve `false` quando
// nada foi enfileirado.
export async function sendTransactionalEmail(
  ctx: MutationCtx,
  args: { to: string; subject: string; html: string; replyTo?: string; kind: string },
): Promise<boolean> {
  const to = normalizeEmail(args.to);
  if (!isDeliverableEmail(to)) {
    console.warn(`[email] ${args.kind}: destinatário inválido ou de teste (${maskEmailForLog(to)}) — não enviado`);
    return false;
  }

  const suppressed = await ctx.db
    .query("emailSuppressions")
    .withIndex("by_email", (q) => q.eq("email", to))
    .first();
  if (suppressed) {
    console.warn(`[email] ${args.kind}: ${maskEmailForLog(to)} suprimido (${suppressed.reason}) — não enviado`);
    return false;
  }

  try {
    await resend.sendEmail(ctx, {
      from: fromAddress(),
      to,
      subject: args.subject,
      html: args.html,
      ...(args.replyTo && isDeliverableEmail(args.replyTo) ? { replyTo: [args.replyTo] } : {}),
    });
    return true;
  } catch (error) {
    console.error(
      `[email] ${args.kind}: falha ao enfileirar para ${maskEmailForLog(to)}:`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

// ── Central notification dispatcher ──
// All notification emails go through this single entry point.
export const dispatchNotification = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    recipientMemberId: v.id("teamMembers"),
    eventType: v.string(),
    templateData: v.any(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    // 1. Get recipient — skip if AI agent or no email
    const member = await ctx.db.get(args.recipientMemberId);
    if (!member || member.type !== "human" || !member.email) return false;

    // Defesa em profundidade multi-tenant: os call sites deveriam barrar membro
    // de outra org, e nem todos barram. Dado de uma org nunca sai por e-mail
    // para membro de outra.
    if (member.organizationId !== args.organizationId) {
      console.warn(`[email] ${args.eventType}: destinatário de outra organização — não enviado`);
      return false;
    }

    // Membro sem conta vinculada (seed, importado) não tem como abrir o link do
    // e-mail — e são justamente os endereços fictícios que virariam bounce.
    if (!member.userId) return false;

    // 2. Check preferences (invite is always sent regardless of prefs)
    if (args.eventType !== "invite") {
      const prefs = await ctx.db
        .query("notificationPreferences")
        .withIndex("by_member", (q) => q.eq("teamMemberId", args.recipientMemberId))
        .first();
      // Opt-out model: no row = all enabled. Check explicit false.
      if (prefs && (prefs as any)[args.eventType] === false) return false;
    }

    // 3. Build template — eventType desconhecido não vira e-mail vazio
    let template;
    try {
      template = buildTemplate(args.eventType, args.templateData);
    } catch (error) {
      console.error(`[email] ${args.eventType}:`, error instanceof Error ? error.message : String(error));
      return false;
    }

    // 4. Send
    return await sendTransactionalEmail(ctx, {
      to: member.email,
      subject: template.subject,
      html: template.html,
      kind: args.eventType,
    });
  },
});

// ── Resend webhook event handler ──
// Hard bounce e denúncia de spam suprimem o endereço para sempre: insistir num
// endereço morto é o caminho mais curto para o domínio cair em spam para todos.
export const handleEmailEvent = internalMutation({
  args: vOnEmailEventArgs.fields,
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = args.event;
    console.log(`[Resend] Email ${args.id} event: ${event.type}`);

    let reason: "bounced" | "complained" | null = null;
    let detail: string | undefined;
    if (event.type === "email.complained") {
      reason = "complained";
    } else if (event.type === "email.bounced") {
      // Bounce transitório (caixa cheia, servidor fora) não condena o endereço.
      if (event.data.bounce.type.toLowerCase() !== "permanent") return null;
      reason = "bounced";
      detail = `${event.data.bounce.subType}: ${event.data.bounce.message}`.slice(0, 300);
    }
    if (!reason) return null;

    const recipients = Array.isArray(event.data.to) ? event.data.to : [event.data.to];
    for (const raw of recipients) {
      const email = normalizeEmail(raw);
      if (!email) continue;
      const existing = await ctx.db
        .query("emailSuppressions")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();
      if (existing) continue;
      await ctx.db.insert("emailSuppressions", { email, reason, detail, createdAt: Date.now() });
      console.warn(`[email] ${maskEmailForLog(email)} suprimido: ${reason}`);
    }
    return null;
  },
});

// ── Form confirmation email (Phase 7) ──
// Sent to the form submitter after they fill out a public form.
export const sendConfirmationEmail = internalMutation({
  args: {
    toEmail: v.string(),
    formName: v.string(),
    subject: v.optional(v.string()),
    body: v.optional(v.string()),
    replyTo: v.optional(v.string()),
    submittedData: v.any(),
    fieldLabels: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const template = buildTemplate("formConfirmation", {
      formName: args.formName,
      subject: args.subject,
      body: args.body,
      submittedData: args.submittedData,
      fieldLabels: args.fieldLabels,
    });

    await sendTransactionalEmail(ctx, {
      to: args.toEmail,
      subject: template.subject,
      html: template.html,
      replyTo: args.replyTo,
      kind: "formConfirmation",
    });

    return null;
  },
});

// ── Daily digest cron handler ──
export const sendDailyDigest = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const digestAppUrl = appUrl();

    // Format date for subject
    const dateStr = new Date(now).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });

    // Get all organizations
    const orgs = await ctx.db.query("organizations").collect();

    for (const org of orgs) {
      // Get human team members who haven't opted out of digest
      const members = await ctx.db
        .query("teamMembers")
        .withIndex("by_organization_and_type", (q) =>
          q.eq("organizationId", org._id).eq("type", "human")
        )
        .collect();

      // Só quem tem conta vinculada recebe (mesmo gate do dispatch) — filtrar
      // aqui evita agendar dezenas de jobs no-op por dia para membros-semente.
      const recipients = members.filter((m) => m.userId && m.email);
      if (recipients.length === 0) continue;

      // Gather yesterday's stats
      const recentLeads = await ctx.db
        .query("leads")
        .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
        .order("desc")
        .take(500);
      const newLeadsCount = recentLeads.filter(
        (l) => l.createdAt >= oneDayAgo && l.archivedAt === undefined
      ).length;

      const recentTasks = await ctx.db
        .query("tasks")
        .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
        .order("desc")
        .take(500);
      const completedTasksCount = recentTasks.filter(
        (t) => t.status === "completed" && t.completedAt && t.completedAt >= oneDayAgo
      ).length;
      const overdueTasksCount = recentTasks.filter(
        (t) =>
          (t.status === "pending" || t.status === "in_progress") &&
          t.dueDate != null &&
          t.dueDate < now
      ).length;

      const pendingHandoffs = await ctx.db
        .query("handoffs")
        .withIndex("by_organization_and_status", (q) =>
          q.eq("organizationId", org._id).eq("status", "pending")
        )
        .collect();
      const pendingHandoffsCount = pendingHandoffs.length;

      // Dia sem nada para contar não vira e-mail: digest zerado todo dia é o
      // que ensina o usuário a ignorar (ou denunciar) o remetente.
      if (newLeadsCount + completedTasksCount + pendingHandoffsCount + overdueTasksCount === 0) continue;

      // Send to each eligible member
      for (const member of recipients) {

        // Check if member opted out of dailyDigest
        const prefs = await ctx.db
          .query("notificationPreferences")
          .withIndex("by_member", (q) => q.eq("teamMemberId", member._id))
          .first();
        if (prefs && prefs.dailyDigest === false) continue;

        await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
          organizationId: org._id,
          recipientMemberId: member._id,
          eventType: "dailyDigest",
          templateData: {
            date: dateStr,
            orgName: org.name,
            newLeadsCount,
            completedTasksCount,
            pendingHandoffsCount,
            overdueTasksCount,
            appUrl: digestAppUrl,
          },
        });
      }
    }

    return null;
  },
});
