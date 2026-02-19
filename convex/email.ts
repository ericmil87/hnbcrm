import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { Resend, vOnEmailEventArgs } from "@convex-dev/resend";
import { buildTemplate } from "./emailTemplates";

// Resend component instance — testMode: true for dev safety, set to false in production
export const resend: Resend = new Resend(components.resend, {
  onEmailEvent: internal.email.handleEmailEvent,
});

// ── Central notification dispatcher ──
// All email sends go through this single entry point.
export const dispatchNotification = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    recipientMemberId: v.id("teamMembers"),
    eventType: v.string(),
    templateData: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // 1. Get recipient — skip if AI agent or no email
    const member = await ctx.db.get(args.recipientMemberId);
    if (!member || member.type !== "human" || !member.email) return null;

    // 2. Check preferences (invite is always sent regardless of prefs)
    if (args.eventType !== "invite") {
      const prefs = await ctx.db
        .query("notificationPreferences")
        .withIndex("by_member", (q) => q.eq("teamMemberId", args.recipientMemberId))
        .first();
      // Opt-out model: no row = all enabled. Check explicit false.
      if (prefs && (prefs as any)[args.eventType] === false) return null;
    }

    // 3. Build template
    const template = buildTemplate(args.eventType, args.templateData);

    // 4. Send via Resend component
    const fromEmail = process.env.RESEND_FROM_EMAIL ?? "HNBCRM <noreply@mail.hnbcrm.com>";
    await resend.sendEmail(ctx, {
      from: fromEmail,
      to: member.email,
      subject: template.subject,
      html: template.html,
    });

    return null;
  },
});

// ── Resend webhook event handler ──
export const handleEmailEvent = internalMutation({
  args: vOnEmailEventArgs.fields,
  returns: v.null(),
  handler: async (_ctx, args) => {
    // Log email events for debugging — can be extended to update delivery status
    console.log(`[Resend] Email ${args.id} event:`, args.event);
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
    const appUrl = process.env.APP_URL ?? "https://app.hnbcrm.com.br";

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

      if (members.length === 0) continue;

      // Gather yesterday's stats
      const recentLeads = await ctx.db
        .query("leads")
        .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
        .order("desc")
        .take(500);
      const newLeadsCount = recentLeads.filter((l) => l.createdAt >= oneDayAgo).length;

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

      // Send to each eligible member
      for (const member of members) {
        if (!member.email) continue;

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
            appUrl,
          },
        });
      }
    }

    return null;
  },
});
