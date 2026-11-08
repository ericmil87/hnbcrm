import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { Resend, vOnEmailEventArgs } from "@convex-dev/resend";
import { buildTemplate } from "./emailTemplates";
import { appUrl } from "./lib/appUrl";
import { isDeliverableEmail, maskEmailForLog, normalizeEmail } from "./lib/emailAddress";
import { isMembershipRevoked } from "./lib/auth";
import { cronsDisabled } from "./lib/cronGuard";
import { shouldDeliver } from "./lib/notificationPolicy";
import { loadMemberPrefs, orgDefaultsOf } from "./lib/notificationPrefs";
import { localDateKey, localParts } from "./lib/executiveReport";
import { safeTimezone } from "./lib/promptDateTime";

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

    // Removido da org não recebe mais nada dela (o vínculo acabou).
    if (isMembershipRevoked(member)) return false;

    // 2. Política única (C1): flag antigo, preferência por canal, preset (membro ou org),
    // pausa e silêncio. `invite` sempre sai. Sem linha e sem padrão da org = tudo liga.
    if (args.eventType !== "invite") {
      const prefs = await loadMemberPrefs(ctx, args.organizationId, args.recipientMemberId);
      const org = prefs?.preset ? null : await ctx.db.get(args.organizationId);
      const decision = shouldDeliver({
        type: args.eventType,
        channel: "email",
        prefs,
        orgDefaults: orgDefaultsOf(org),
        now: Date.now(),
      });
      if (decision !== "deliver") return false;
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

// ── Daily digest ──
const DIGEST_COUNT_CAP = 500;
/** Janela LOCAL da org em que o resumo pode sair: a partir das 08h, até as 11h59 (recupera rodada falha). */
export const DIGEST_LOCAL_HOUR = 8;
export const DIGEST_LOCAL_HOUR_END = 12;
/** Orgs lidas por execução; o resto segue por cursor (uma `.paginate()` por função). */
const DIGEST_ORG_PAGE = 100;

/**
 * Cron de hora em hora (minuto 0). Só SELECIONA: orgs com hora local em [08h, 12h) e
 * sem o carimbo `lastDailyDigestDate` de hoje ganham UM job interno (`internalSendOrgDigest`),
 * que conta e envia. O carimbo é gravado pelo job, na mesma transação do envio: se a rodada
 * falhar, o carimbo não existe e a hora seguinte tenta de novo. Custo: ler os docs das orgs
 * 1x/hora (paginado).
 */
export const sendDailyDigest = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), now: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (cronsDisabled()) return null;
    const now = args.now ?? Date.now();
    const page = await ctx.db
      .query("organizations")
      .paginate({ numItems: DIGEST_ORG_PAGE, cursor: args.cursor ?? null });

    for (const org of page.page) {
      const tz = safeTimezone(org.settings.timezone);
      const hour = localParts(now, tz).hour;
      if (hour < DIGEST_LOCAL_HOUR || hour >= DIGEST_LOCAL_HOUR_END) continue;
      if (org.lastDailyDigestDate === localDateKey(now, tz)) continue;
      await ctx.scheduler.runAfter(0, internal.email.internalSendOrgDigest, { organizationId: org._id, now });
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.email.sendDailyDigest, { cursor: page.continueCursor, now });
    }
    return null;
  },
});

/** Resumo de UMA org: idempotente pelo carimbo da data local; conta por range e agenda os e-mails. */
export const internalSendOrgDigest = internalMutation({
  args: { organizationId: v.id("organizations"), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    if (!org) return null;
    const now = args.now;
    const tz = safeTimezone(org.settings.timezone);
    const dateKey = localDateKey(now, tz);
    if (org.lastDailyDigestDate === dateKey) return null;
    await ctx.db.patch(org._id, { lastDailyDigestDate: dateKey });

    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const digestAppUrl = appUrl();
    const dateStr = new Date(now).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: tz,
    });

    const members = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_type", (q) => q.eq("organizationId", org._id).eq("type", "human"))
      .collect();

    // Só quem tem conta vinculada recebe (mesmo gate do dispatch).
    const recipients = members.filter((m) => m.userId && m.email && !isMembershipRevoked(m));
    if (recipients.length === 0) return null;

    // Contagens por RANGE de índice (perf Convex I/O, fase 1): antes lia os
    // 500 leads e as 500 tarefas mais recentes da org só para contar. Teto
    // de 500 por contagem, o mesmo de antes.
    const recentLeads = await ctx.db
      .query("leads")
      .withIndex("by_organization_and_created", (q) =>
        q.eq("organizationId", org._id).gte("createdAt", oneDayAgo)
      )
      .take(DIGEST_COUNT_CAP);
    const newLeadsCount = recentLeads.filter((l) => l.archivedAt === undefined).length;

    // `completedAt` é limpo ao reabrir, mas o status é conferido de novo.
    const completedTasks = await ctx.db
      .query("tasks")
      .withIndex("by_organization_and_completed_at", (q) =>
        q.eq("organizationId", org._id).gte("completedAt", oneDayAgo)
      )
      .take(DIGEST_COUNT_CAP);
    const completedTasksCount = completedTasks.filter((t) => t.status === "completed").length;

    // `.gt(undefined)` exclui tarefa sem prazo (undefined ordena antes de tudo).
    let overdueTasksCount = 0;
    for (const status of ["pending", "in_progress"] as const) {
      const overdue = await ctx.db
        .query("tasks")
        .withIndex("by_organization_and_status_and_due_date", (q) =>
          q
            .eq("organizationId", org._id)
            .eq("status", status)
            .gt("dueDate", undefined)
            .lt("dueDate", now)
        )
        .take(DIGEST_COUNT_CAP);
      overdueTasksCount += overdue.length;
    }

    const pendingHandoffs = await ctx.db
      .query("handoffs")
      .withIndex("by_organization_and_status", (q) =>
        q.eq("organizationId", org._id).eq("status", "pending")
      )
      .collect();
    const pendingHandoffsCount = pendingHandoffs.length;

    // Dia sem nada para contar não vira e-mail: digest zerado todo dia é o
    // que ensina o usuário a ignorar (ou denunciar) o remetente.
    if (newLeadsCount + completedTasksCount + pendingHandoffsCount + overdueTasksCount === 0) return null;

      // Send to each eligible member
      for (const member of recipients) {
        // Mesma política do dispatch (canal explícito, preset, pausa) antes de agendar:
        // quem não vai receber não gera job. O digest ignora o horário de silêncio.
        const prefs = await loadMemberPrefs(ctx, org._id, member._id);
        const decision = shouldDeliver({
          type: "dailyDigest",
          channel: "email",
          prefs,
          orgDefaults: orgDefaultsOf(org),
          now,
        });
        if (decision !== "deliver") continue;

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
    return null;
  },
});
