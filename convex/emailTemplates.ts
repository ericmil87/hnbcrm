// Pure TypeScript email template builders — no Node.js APIs needed.
// All text in PT-BR. Returns { subject, html } for each template type.

const BRAND_ORANGE = "#EA580C";
const BG_DARK = "#0d0d0d";
const CARD_BG = "#1a1a1a";
const TEXT_PRIMARY = "#f5f5f5";
const TEXT_SECONDARY = "#a3a3a3";
const BORDER_COLOR = "#2a2a2a";

function baseTemplate(opts: {
  preheader: string;
  content: string;
  appUrl: string;
}): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>HNBCRM</title>
  <style>
    body { margin: 0; padding: 0; background-color: ${BG_DARK}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .preheader { display: none !important; max-height: 0; overflow: hidden; mso-hide: all; }
  </style>
</head>
<body>
  <span class="preheader">${opts.preheader}</span>
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color: ${BG_DARK}; padding: 32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width: 600px;">
        <!-- Logo -->
        <tr><td style="padding-bottom: 24px; text-align: center;">
          <span style="font-size: 24px; font-weight: 700; color: ${BRAND_ORANGE};">HNBCRM</span>
        </td></tr>
        <!-- Content Card -->
        <tr><td style="background-color: ${CARD_BG}; border: 1px solid ${BORDER_COLOR}; border-radius: 12px; padding: 32px;">
          ${opts.content}
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding-top: 24px; text-align: center; color: ${TEXT_SECONDARY}; font-size: 12px; line-height: 1.5;">
          <p style="margin: 0;">HNBCRM &mdash; CRM inteligente para equipes de vendas</p>
          <p style="margin: 4px 0 0;">
            <a href="${opts.appUrl}/app/configuracoes" style="color: ${TEXT_SECONDARY}; text-decoration: underline;">Gerenciar preferencias de email</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function ctaButton(label: string, url: string): string {
  return `<table cellpadding="0" cellspacing="0" role="presentation" style="margin-top: 24px;">
    <tr><td style="background-color: ${BRAND_ORANGE}; border-radius: 9999px; padding: 12px 28px;">
      <a href="${url}" style="color: #ffffff; text-decoration: none; font-weight: 600; font-size: 14px; display: inline-block;">${label}</a>
    </td></tr>
  </table>`;
}

function heading(text: string): string {
  return `<h2 style="margin: 0 0 16px; font-size: 20px; font-weight: 700; color: ${TEXT_PRIMARY};">${text}</h2>`;
}

function paragraph(text: string): string {
  return `<p style="margin: 0 0 12px; font-size: 14px; line-height: 1.6; color: ${TEXT_SECONDARY};">${text}</p>`;
}

function infoRow(label: string, value: string): string {
  return `<tr>
    <td style="padding: 8px 0; font-size: 13px; color: ${TEXT_SECONDARY}; width: 120px; vertical-align: top;">${label}</td>
    <td style="padding: 8px 0; font-size: 13px; color: ${TEXT_PRIMARY}; vertical-align: top;">${value}</td>
  </tr>`;
}

function infoTable(rows: string): string {
  return `<table cellpadding="0" cellspacing="0" role="presentation" style="width: 100%; margin-top: 16px; border-top: 1px solid ${BORDER_COLOR}; padding-top: 12px;">
    ${rows}
  </table>`;
}

// ──────────────────────────────────────────────
// Template Builders
// ──────────────────────────────────────────────

export type TemplateResult = { subject: string; html: string };

export function buildInviteTemplate(data: {
  memberName: string;
  orgName: string;
  email: string;
  tempPassword: string;
  loginUrl: string;
}): TemplateResult {
  const appUrl = data.loginUrl.replace(/\/entrar$/, "");
  return {
    subject: `Voce foi convidado para ${data.orgName}`,
    html: baseTemplate({
      preheader: `${data.memberName}, voce foi convidado para ${data.orgName} no HNBCRM.`,
      appUrl,
      content: `
        ${heading(`Bem-vindo ao ${data.orgName}!`)}
        ${paragraph(`Ola ${data.memberName}, voce foi convidado para fazer parte da equipe <strong style="color: ${TEXT_PRIMARY};">${data.orgName}</strong> no HNBCRM.`)}
        ${paragraph("Use as credenciais abaixo para acessar o sistema. Voce devera trocar a senha no primeiro acesso.")}
        ${infoTable(`
          ${infoRow("Email", data.email)}
          ${infoRow("Senha temporaria", `<code style="background: ${BG_DARK}; padding: 2px 8px; border-radius: 4px; color: ${BRAND_ORANGE}; font-size: 14px;">${data.tempPassword}</code>`)}
        `)}
        ${ctaButton("Acessar HNBCRM", data.loginUrl)}
      `,
    }),
  };
}

export function buildHandoffRequestedTemplate(data: {
  leadTitle: string;
  reason: string;
  suggestedActions?: string[];
  fromMemberName: string;
  leadUrl: string;
}): TemplateResult {
  const appUrl = data.leadUrl.replace(/\/app\/.*$/, "");
  const actionsList = data.suggestedActions?.length
    ? `<ul style="margin: 8px 0 0; padding-left: 20px; color: ${TEXT_SECONDARY}; font-size: 13px; line-height: 1.6;">${data.suggestedActions.map(a => `<li>${a}</li>`).join("")}</ul>`
    : "";
  return {
    subject: `Repasse solicitado: ${data.leadTitle}`,
    html: baseTemplate({
      preheader: `${data.fromMemberName} solicitou um repasse para o lead "${data.leadTitle}".`,
      appUrl,
      content: `
        ${heading("Repasse Solicitado")}
        ${paragraph(`<strong style="color: ${TEXT_PRIMARY};">${data.fromMemberName}</strong> solicitou um repasse para voce.`)}
        ${infoTable(`
          ${infoRow("Lead", data.leadTitle)}
          ${infoRow("Motivo", data.reason)}
        `)}
        ${actionsList ? `<div style="margin-top: 12px;">${paragraph("<strong style='color: " + TEXT_PRIMARY + ";'>Acoes sugeridas:</strong>")}${actionsList}</div>` : ""}
        ${ctaButton("Ver Repasse", data.leadUrl)}
      `,
    }),
  };
}

export function buildHandoffResolvedTemplate(data: {
  leadTitle: string;
  status: "aceito" | "rejeitado";
  resolvedByName: string;
  leadUrl: string;
}): TemplateResult {
  const appUrl = data.leadUrl.replace(/\/app\/.*$/, "");
  const statusColor = data.status === "aceito" ? "#22c55e" : "#ef4444";
  return {
    subject: `Repasse ${data.status}: ${data.leadTitle}`,
    html: baseTemplate({
      preheader: `Seu repasse para "${data.leadTitle}" foi ${data.status} por ${data.resolvedByName}.`,
      appUrl,
      content: `
        ${heading("Repasse Resolvido")}
        ${paragraph(`Seu repasse para o lead <strong style="color: ${TEXT_PRIMARY};">${data.leadTitle}</strong> foi <strong style="color: ${statusColor};">${data.status}</strong> por ${data.resolvedByName}.`)}
        ${ctaButton("Ver Lead", data.leadUrl)}
      `,
    }),
  };
}

export function buildTaskOverdueTemplate(data: {
  taskTitle: string;
  dueDate: string;
  leadTitle?: string;
  taskUrl: string;
}): TemplateResult {
  const appUrl = data.taskUrl.replace(/\/app\/.*$/, "");
  return {
    subject: `Tarefa atrasada: ${data.taskTitle}`,
    html: baseTemplate({
      preheader: `A tarefa "${data.taskTitle}" esta atrasada.`,
      appUrl,
      content: `
        ${heading("Tarefa Atrasada")}
        ${paragraph("Uma tarefa atribuida a voce esta atrasada e precisa de atencao.")}
        ${infoTable(`
          ${infoRow("Tarefa", data.taskTitle)}
          ${infoRow("Vencimento", data.dueDate)}
          ${data.leadTitle ? infoRow("Lead", data.leadTitle) : ""}
        `)}
        ${ctaButton("Ver Tarefa", data.taskUrl)}
      `,
    }),
  };
}

export function buildTaskAssignedTemplate(data: {
  taskTitle: string;
  dueDate?: string;
  assignedByName: string;
  leadTitle?: string;
  taskUrl: string;
}): TemplateResult {
  const appUrl = data.taskUrl.replace(/\/app\/.*$/, "");
  return {
    subject: `Nova tarefa atribuida: ${data.taskTitle}`,
    html: baseTemplate({
      preheader: `${data.assignedByName} atribuiu a tarefa "${data.taskTitle}" a voce.`,
      appUrl,
      content: `
        ${heading("Nova Tarefa Atribuida")}
        ${paragraph(`<strong style="color: ${TEXT_PRIMARY};">${data.assignedByName}</strong> atribuiu uma tarefa a voce.`)}
        ${infoTable(`
          ${infoRow("Tarefa", data.taskTitle)}
          ${data.dueDate ? infoRow("Vencimento", data.dueDate) : ""}
          ${data.leadTitle ? infoRow("Lead", data.leadTitle) : ""}
        `)}
        ${ctaButton("Ver Tarefa", data.taskUrl)}
      `,
    }),
  };
}

export function buildLeadAssignedTemplate(data: {
  leadTitle: string;
  value?: string;
  stage?: string;
  contactName?: string;
  assignedByName: string;
  leadUrl: string;
}): TemplateResult {
  const appUrl = data.leadUrl.replace(/\/app\/.*$/, "");
  return {
    subject: `Lead atribuido: ${data.leadTitle}`,
    html: baseTemplate({
      preheader: `${data.assignedByName} atribuiu o lead "${data.leadTitle}" a voce.`,
      appUrl,
      content: `
        ${heading("Lead Atribuido")}
        ${paragraph(`<strong style="color: ${TEXT_PRIMARY};">${data.assignedByName}</strong> atribuiu um lead a voce.`)}
        ${infoTable(`
          ${infoRow("Lead", data.leadTitle)}
          ${data.contactName ? infoRow("Contato", data.contactName) : ""}
          ${data.value ? infoRow("Valor", data.value) : ""}
          ${data.stage ? infoRow("Estagio", data.stage) : ""}
        `)}
        ${ctaButton("Ver Lead", data.leadUrl)}
      `,
    }),
  };
}

export function buildNewMessageTemplate(data: {
  leadTitle: string;
  messagePreview: string;
  channel: string;
  senderName: string;
  conversationUrl: string;
}): TemplateResult {
  const appUrl = data.conversationUrl.replace(/\/app\/.*$/, "");
  const channelLabels: Record<string, string> = {
    whatsapp: "WhatsApp",
    telegram: "Telegram",
    email: "Email",
    webchat: "Webchat",
    internal: "Interno",
  };
  return {
    subject: `Nova mensagem em ${data.leadTitle}`,
    html: baseTemplate({
      preheader: `${data.senderName} enviou uma mensagem no lead "${data.leadTitle}".`,
      appUrl,
      content: `
        ${heading("Nova Mensagem")}
        ${paragraph(`Uma nova mensagem foi recebida no lead <strong style="color: ${TEXT_PRIMARY};">${data.leadTitle}</strong>.`)}
        ${infoTable(`
          ${infoRow("Canal", channelLabels[data.channel] ?? data.channel)}
          ${infoRow("Remetente", data.senderName)}
        `)}
        <div style="margin-top: 16px; padding: 12px 16px; background: ${BG_DARK}; border-radius: 8px; border-left: 3px solid ${BRAND_ORANGE};">
          <p style="margin: 0; font-size: 13px; color: ${TEXT_SECONDARY}; line-height: 1.5; font-style: italic;">"${data.messagePreview}"</p>
        </div>
        ${ctaButton("Ver Conversa", data.conversationUrl)}
      `,
    }),
  };
}

export function buildDailyDigestTemplate(data: {
  date: string;
  orgName: string;
  newLeadsCount: number;
  completedTasksCount: number;
  pendingHandoffsCount: number;
  overdueTasksCount: number;
  appUrl: string;
}): TemplateResult {
  return {
    subject: `Resumo diario - ${data.date}`,
    html: baseTemplate({
      preheader: `Resumo de ${data.orgName}: ${data.newLeadsCount} novos leads, ${data.completedTasksCount} tarefas concluidas.`,
      appUrl: data.appUrl,
      content: `
        ${heading(`Resumo Diario - ${data.date}`)}
        ${paragraph(`Aqui esta o resumo das atividades de ontem em <strong style="color: ${TEXT_PRIMARY};">${data.orgName}</strong>.`)}
        <table cellpadding="0" cellspacing="0" role="presentation" style="width: 100%; margin-top: 16px;">
          <tr>
            <td style="width: 50%; padding: 12px; text-align: center; background: ${BG_DARK}; border-radius: 8px;">
              <div style="font-size: 28px; font-weight: 700; color: ${BRAND_ORANGE};">${data.newLeadsCount}</div>
              <div style="font-size: 12px; color: ${TEXT_SECONDARY}; margin-top: 4px;">Novos leads</div>
            </td>
            <td style="width: 8px;"></td>
            <td style="width: 50%; padding: 12px; text-align: center; background: ${BG_DARK}; border-radius: 8px;">
              <div style="font-size: 28px; font-weight: 700; color: #22c55e;">${data.completedTasksCount}</div>
              <div style="font-size: 12px; color: ${TEXT_SECONDARY}; margin-top: 4px;">Tarefas concluidas</div>
            </td>
          </tr>
          <tr><td colspan="3" style="height: 8px;"></td></tr>
          <tr>
            <td style="width: 50%; padding: 12px; text-align: center; background: ${BG_DARK}; border-radius: 8px;">
              <div style="font-size: 28px; font-weight: 700; color: #eab308;">${data.pendingHandoffsCount}</div>
              <div style="font-size: 12px; color: ${TEXT_SECONDARY}; margin-top: 4px;">Repasses pendentes</div>
            </td>
            <td style="width: 8px;"></td>
            <td style="width: 50%; padding: 12px; text-align: center; background: ${BG_DARK}; border-radius: 8px;">
              <div style="font-size: 28px; font-weight: 700; color: ${data.overdueTasksCount > 0 ? "#ef4444" : TEXT_SECONDARY};">${data.overdueTasksCount}</div>
              <div style="font-size: 12px; color: ${TEXT_SECONDARY}; margin-top: 4px;">Tarefas atrasadas</div>
            </td>
          </tr>
        </table>
        ${ctaButton("Abrir HNBCRM", data.appUrl + "/app/painel")}
      `,
    }),
  };
}

export function buildFormSubmissionTemplate(data: {
  formName: string;
  contactEmail?: string;
  contactName?: string;
  leadUrl: string;
}): TemplateResult {
  const appUrl = data.leadUrl.replace(/\/app\/.*$/, "");
  return {
    subject: `Nova submissao de formulario: ${data.formName}`,
    html: baseTemplate({
      preheader: `Uma nova submissao foi recebida no formulario "${data.formName}".`,
      appUrl,
      content: `
        ${heading("Nova Submissao de Formulario")}
        ${paragraph(`Uma nova submissao foi recebida no formulario <strong style="color: ${TEXT_PRIMARY};">${data.formName}</strong>.`)}
        ${infoTable(`
          ${infoRow("Formulario", data.formName)}
          ${data.contactEmail ? infoRow("Email", data.contactEmail) : ""}
          ${data.contactName ? infoRow("Contato", data.contactName) : ""}
        `)}
        ${ctaButton("Ver Lead", data.leadUrl)}
      `,
    }),
  };
}

// ──────────────────────────────────────────────
// Template Dispatcher
// ──────────────────────────────────────────────

export function buildTemplate(
  eventType: string,
  data: Record<string, any>,
): TemplateResult {
  switch (eventType) {
    case "invite":
      return buildInviteTemplate(data as any);
    case "handoffRequested":
      return buildHandoffRequestedTemplate(data as any);
    case "handoffResolved":
      return buildHandoffResolvedTemplate(data as any);
    case "taskOverdue":
      return buildTaskOverdueTemplate(data as any);
    case "taskAssigned":
      return buildTaskAssignedTemplate(data as any);
    case "leadAssigned":
      return buildLeadAssignedTemplate(data as any);
    case "newMessage":
      return buildNewMessageTemplate(data as any);
    case "dailyDigest":
      return buildDailyDigestTemplate(data as any);
    case "formSubmission":
      return buildFormSubmissionTemplate(data as any);
    default:
      return {
        subject: "Notificacao HNBCRM",
        html: `<p>Evento: ${eventType}</p>`,
      };
  }
}
