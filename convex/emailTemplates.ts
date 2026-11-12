// Pure TypeScript email template builders — no Node.js APIs needed.
// All text in PT-BR. Returns { subject, html } for each template type.

import { appUrl as resolveAppUrl } from "./lib/appUrl";

// Identidade "Encaixe" / tema padrão "Estilo WhatsApp". Claro por padrão; o bloco `prefers-color-scheme: dark`
// da casca troca as cores por valor (seletor de atributo no `style` inline), então estas constantes são
// a única fonte e qualquer cor nova deve entrar também em `DARK_OVERRIDES`.
export const BRAND = "#008069"; // botão primário (texto branco = AA)
export const BRAND_LIGHT = "#00A884";
export const BRAND_LINK = "#006B58"; // verde escuro para links/destaques sobre branco
const BG_PAGE = "#F0F2F5";
const BG_SOFT = "#F0F2F5";
const CARD_BG = "#FFFFFF";
const TEXT_PRIMARY = "#111B21";
const TEXT_SECONDARY = "#54656F";
const BORDER_COLOR = "#E9EDEF";
const OK_COLOR = "#067647";
const WARN_COLOR = "#B54708";
const BAD_COLOR = "#B42318";
const FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Par claro -> escuro, aplicado por `[style*="..."]` no modo escuro do cliente de e-mail. */
const DARK_OVERRIDES: Array<[prop: "color" | "background-color" | "background" | "border-color", light: string, dark: string]> = [
  ["background-color", BG_PAGE, "#111B21"],
  ["background-color", CARD_BG, "#202C33"],
  ["background", BG_SOFT, "#111B21"],
  ["color", TEXT_PRIMARY, "#E9EDEF"],
  ["color", TEXT_SECONDARY, "#AEBAC1"],
  ["color", BRAND_LINK, "#25D3A3"],
  ["color", OK_COLOR, "#4ADE80"],
  ["color", WARN_COLOR, "#FBBF24"],
  ["color", BAD_COLOR, "#F87171"],
];

function darkCss(): string {
  const rules = DARK_OVERRIDES.map(([prop, light, dark]) => {
    const sel = `[style*="${prop}: ${light}"]`;
    return `    ${sel} { ${prop === "background" ? "background-color" : prop}: ${dark} !important; }`;
  });
  return `  @media (prefers-color-scheme: dark) {
    .em-border { border-color: #2A3942 !important; }
${rules.join("\n")}
  }`;
}

export function baseTemplate(opts: {
  preheader: string;
  content: string;
  appUrl: string;
}): string {
  const logoUrl = safeUrl(`${resolveAppUrl()}/brand/email-logo.png`);
  return `<!DOCTYPE html>
<html lang="pt-BR" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <title>HNBCRM</title>
  <style>
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
    body { margin: 0; padding: 0; background-color: ${BG_PAGE}; font-family: ${FONT_STACK}; -webkit-text-size-adjust: 100%; }
    .preheader { display: none !important; visibility: hidden; opacity: 0; max-height: 0; max-width: 0; overflow: hidden; mso-hide: all; }
    @media only screen and (max-width: 480px) { .em-card { padding: 24px 20px !important; } }
${darkCss()}
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: ${BG_PAGE};">
  <span class="preheader" style="display: none; max-height: 0; overflow: hidden;">${opts.preheader}</span>
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color: ${BG_PAGE}; padding: 24px 12px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width: 560px;">
        <!-- Logo -->
        <tr><td style="padding: 8px 0 20px; text-align: center; font-family: ${FONT_STACK};">
          <img class="em-logo" src="${logoUrl}" width="150" height="42" alt="HNBCRM" style="display: inline-block; border: 0; outline: none; height: 42px; width: 150px; font-family: ${FONT_STACK}; font-size: 22px; font-weight: 700; line-height: 42px; color: ${TEXT_PRIMARY};" />
        </td></tr>
        <!-- Content Card -->
        <tr><td class="em-card em-border" style="background-color: ${CARD_BG}; border: 1px solid ${BORDER_COLOR}; border-radius: 16px; padding: 32px; font-family: ${FONT_STACK};">
          ${opts.content}
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding-top: 24px; text-align: center; color: ${TEXT_SECONDARY}; font-family: ${FONT_STACK}; font-size: 12px; line-height: 1.5;">
          <p style="margin: 0; color: ${TEXT_SECONDARY};">HNBCRM · Humanos e IAs no mesmo time</p>
          <p style="margin: 4px 0 0;">
            <a href="${safeUrl(`${opts.appUrl}/app/configuracoes`)}" style="color: ${BRAND_LINK}; text-decoration: underline;">Gerenciar preferências de e-mail</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * URL de `href`: só `https:`, `http://localhost` ou caminho do app ("/..."). Qualquer outra
 * coisa (`javascript:`, `data:`, `//host`) vira "#". Sempre escapada como atributo.
 */
export function safeUrl(url: string): string {
  const u = String(url ?? "").trim();
  const ok =
    /^https:\/\//i.test(u) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(u) ||
    (u.startsWith("/") && !u.startsWith("//") && !u.startsWith("/\\"));
  return escapeHtml(ok ? u : "#");
}

/** Assunto é texto puro (sem entidades): só tira quebras de linha (header injection). */
export function line(text: unknown): string {
  return String(text ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").trim();
}

/** Cópia rasa com todo valor string escapado (números/booleanos passam). Use nos campos de texto. */
export function escapeStrings<T extends object>(data: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = typeof v === "string" ? escapeHtml(v) : v;
  }
  return out as T;
}

export function ctaButton(label: string, url: string): string {
  return `<table cellpadding="0" cellspacing="0" role="presentation" style="margin-top: 24px;">
    <tr><td style="background-color: ${BRAND}; border-radius: 9999px; padding: 0;">
      <a href="${safeUrl(url)}" style="color: #ffffff; text-decoration: none; font-weight: 600; font-size: 16px; line-height: 20px; display: inline-block; padding: 14px 32px; border-radius: 9999px; font-family: ${FONT_STACK};">${escapeHtml(label)}</a>
    </td></tr>
  </table>`;
}

/**
 * Escapa HTML de texto que veio de FORA (gerado por LLM, escrito pelo usuário).
 * Os templates antigos interpolam dados do próprio CRM; aqui o corpo é um texto
 * livre que vai ser publicado num grupo — `<script>` nele não pode virar tag
 * dentro do e-mail de aprovação.
 */
export function escapeHtml(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function heading(text: string): string {
  return `<h2 style="margin: 0 0 16px; font-size: 20px; font-weight: 700; color: ${TEXT_PRIMARY};">${text}</h2>`;
}

export function paragraph(text: string): string {
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
  const e = escapeStrings(data);
  const appUrl = data.loginUrl.replace(/\/entrar$/, "");
  return {
    subject: `Voce foi convidado para ${line(data.orgName)}`,
    html: baseTemplate({
      preheader: `${e.memberName}, você foi convidado para ${e.orgName} no HNBCRM.`,
      appUrl,
      content: `
        ${heading(`Bem-vindo ao ${e.orgName}!`)}
        ${paragraph(`Olá ${e.memberName}, você foi convidado para fazer parte da equipe <strong style="color: ${TEXT_PRIMARY};">${e.orgName}</strong> no HNBCRM.`)}
        ${paragraph("Use as credenciais abaixo para acessar o HNBCRM. Você deverá trocar a senha no primeiro acesso.")}
        ${infoTable(`
          ${infoRow("E-mail", e.email)}
          ${infoRow("Senha temporária", `<code style="background: ${BG_SOFT}; padding: 2px 8px; border-radius: 4px; color: ${BRAND_LINK}; font-size: 14px;">${e.tempPassword}</code>`)}
        `)}
        ${ctaButton("Acessar HNBCRM", data.loginUrl)}
      `,
    }),
  };
}

const HANDOFF_ORIGIN_LABELS: Record<string, string> = {
  human: "Pedido de um colega",
  ai_keyword: "O cliente pediu para falar com uma pessoa",
  ai_tool: "A IA pediu ajuda da equipe",
  ai_failure: "Falha da IA",
  bot_suspect: "Suspeita de robô do outro lado",
  ai_budget: "Teto de gastos de IA atingido",
};

/** Oculta sequências longas de dígitos (telefone no título do lead) — LGPD. */
export function maskDigitRuns(text: string): string {
  return text.replace(/\d[\d\s().+-]{6,}\d/g, (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 8 ? `••••${digits.slice(-4)}` : m;
  });
}

export function buildHandoffRequestedTemplate(data: {
  orgName?: string;
  leadTitle: string;
  origin?: string;
  reason?: string;
  /** O repasse foi pedido por uma PESSOA (membro de origem humano). */
  fromIsHuman?: boolean;
  /** "3" ou "20+" quando há mais de um repasse pendente na org. */
  pendingLabel?: string;
  fromMemberName: string;
  leadUrl: string;
}): TemplateResult {
  const appUrl = data.leadUrl.replace(/\/app\/.*$/, "");
  const title = escapeHtml(maskDigitRuns(data.leadTitle));
  const originLabel = HANDOFF_ORIGIN_LABELS[data.origin ?? "human"] ?? HANDOFF_ORIGIN_LABELS.human;
  // O motivo em texto livre só vai quando uma PESSOA o escreveu (membro de origem humano): o da IA pode
  // citar a conversa do cliente, e e-mail não é lugar de conteúdo de mensagem.
  const showReason = !!data.reason && data.fromIsHuman === true;
  const orgLine = data.orgName ? infoRow("Empresa", escapeHtml(data.orgName)) : "";
  return {
    subject: data.pendingLabel
      ? `Novo repasse — ${line(data.pendingLabel)} pendentes`
      : `Repasse solicitado: ${line(maskDigitRuns(data.leadTitle))}`,
    html: baseTemplate({
      preheader: `${data.orgName ? escapeHtml(data.orgName) + ": " : ""}pedido de ajuda pendente para o lead "${title}".`,
      appUrl,
      content: `
        ${heading("Pedido de ajuda")}
        ${paragraph(`<strong style="color: ${TEXT_PRIMARY};">${escapeHtml(data.fromMemberName)}</strong> pediu ajuda: a conversa precisa de uma pessoa.`)}
        ${infoTable(`
          ${orgLine}
          ${infoRow("Lead", title)}
          ${infoRow("Origem", escapeHtml(originLabel))}
          ${showReason ? infoRow("Motivo", escapeHtml(data.reason!.slice(0, 300))) : ""}
        `)}
        ${paragraph("Abra o pedido no HNBCRM para ver a conversa e assumir.")}
        ${ctaButton("Ver pedido de ajuda", data.leadUrl)}
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
  const e = escapeStrings(data);
  const appUrl = data.leadUrl.replace(/\/app\/.*$/, "");
  const statusColor = e.status === "aceito" ? OK_COLOR : BAD_COLOR;
  return {
    subject: `Repasse ${line(data.status)}: ${line(data.leadTitle)}`,
    html: baseTemplate({
      preheader: `Seu pedido de ajuda para "${e.leadTitle}" foi ${e.status} por ${e.resolvedByName}.`,
      appUrl,
      content: `
        ${heading("Pedido de ajuda resolvido")}
        ${paragraph(`Seu pedido de ajuda para o lead <strong style="color: ${TEXT_PRIMARY};">${e.leadTitle}</strong> foi <strong style="color: ${statusColor};">${e.status}</strong> por ${e.resolvedByName}.`)}
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
  const e = escapeStrings(data);
  const appUrl = data.taskUrl.replace(/\/app\/.*$/, "");
  return {
    subject: `Tarefa atrasada: ${line(data.taskTitle)}`,
    html: baseTemplate({
      preheader: `A tarefa "${e.taskTitle}" esta atrasada.`,
      appUrl,
      content: `
        ${heading("Tarefa Atrasada")}
        ${paragraph("Uma tarefa atribuida a voce esta atrasada e precisa de atencao.")}
        ${infoTable(`
          ${infoRow("Tarefa", e.taskTitle)}
          ${infoRow("Vencimento", e.dueDate)}
          ${e.leadTitle ? infoRow("Lead", e.leadTitle) : ""}
        `)}
        ${ctaButton("Ver Tarefa", data.taskUrl)}
      `,
    }),
  };
}

export function buildTaskOverdueSummaryTemplate(data: {
  count: number;
  tasks: { title: string; dueDate: string; taskUrl: string }[];
  appUrl: string;
}): TemplateResult {
  const more = data.count - data.tasks.length;
  return {
    subject: `${data.count} tarefas atrasadas`,
    html: baseTemplate({
      preheader: `Voce tem ${data.count} tarefas atrasadas.`,
      appUrl: data.appUrl,
      content: `
        ${heading("Tarefas Atrasadas")}
        ${paragraph(`${data.count} tarefas atribuidas a voce estao atrasadas e precisam de atencao.`)}
        ${infoTable(data.tasks.map((t) => infoRow(escapeHtml(t.title), `Vencimento: ${escapeHtml(t.dueDate)}`)).join(""))}
        ${more > 0 ? paragraph(`e mais ${more}.`) : ""}
        ${ctaButton("Ver Tarefas", data.tasks[0]?.taskUrl ?? data.appUrl)}
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
  const e = escapeStrings(data);
  const appUrl = data.taskUrl.replace(/\/app\/.*$/, "");
  return {
    subject: `Nova tarefa atribuida: ${line(data.taskTitle)}`,
    html: baseTemplate({
      preheader: `${e.assignedByName} atribuiu a tarefa "${e.taskTitle}" a voce.`,
      appUrl,
      content: `
        ${heading("Nova Tarefa Atribuida")}
        ${paragraph(`<strong style="color: ${TEXT_PRIMARY};">${e.assignedByName}</strong> atribuiu uma tarefa a voce.`)}
        ${infoTable(`
          ${infoRow("Tarefa", e.taskTitle)}
          ${e.dueDate ? infoRow("Vencimento", e.dueDate) : ""}
          ${e.leadTitle ? infoRow("Lead", e.leadTitle) : ""}
        `)}
        ${ctaButton("Ver Tarefa", data.taskUrl)}
      `,
    }),
  };
}

export function buildTaskCommentMentionTemplate(data: {
  authorName: string;
  taskTitle: string;
  taskId?: string;
  taskUrl?: string;
  commentExcerpt?: string;
  appUrl?: string;
}): TemplateResult {
  const e = escapeStrings(data);
  const appUrl = data.appUrl || data.taskUrl?.replace(/\/app\/.*$/, "") || resolveAppUrl();
  const taskUrl = data.taskUrl || `${appUrl}/app/tarefas?task=${data.taskId ?? ""}`;
  const excerptBlock = e.commentExcerpt
    ? `<div style="margin-top: 16px; padding: 12px 16px; background: ${BG_SOFT}; border-radius: 8px; border-left: 3px solid ${BRAND_LINK};">
        <p style="margin: 0; font-size: 13px; color: ${TEXT_SECONDARY}; line-height: 1.5; font-style: italic;">"${e.commentExcerpt}"</p>
      </div>`
    : "";
  return {
    subject: `${line(data.authorName)} mencionou você em um comentário`,
    html: baseTemplate({
      preheader: `${e.authorName} mencionou você em um comentário na tarefa "${e.taskTitle}".`,
      appUrl,
      content: `
        ${heading("Você foi mencionado")}
        ${paragraph(`<strong style="color: ${TEXT_PRIMARY};">${e.authorName}</strong> mencionou você em um comentário na tarefa <strong style="color: ${TEXT_PRIMARY};">${e.taskTitle}</strong>.`)}
        ${excerptBlock}
        ${ctaButton("Ver Tarefa", taskUrl)}
      `,
    }),
  };
}

export function buildTaskDueSoonTemplate(data: {
  taskTitle: string;
  taskId?: string;
  taskUrl?: string;
  dueDate: string;
  minutesBefore?: number;
  appUrl?: string;
}): TemplateResult {
  const e = escapeStrings(data);
  const appUrl = data.appUrl || data.taskUrl?.replace(/\/app\/.*$/, "") || resolveAppUrl();
  const taskUrl = data.taskUrl || `${appUrl}/app/tarefas?task=${data.taskId ?? ""}`;
  const leadTime = e.minutesBefore
    ? e.minutesBefore >= 60
      ? `${Math.round(e.minutesBefore / 60)} h`
      : `${e.minutesBefore} min`
    : undefined;
  return {
    subject: `Tarefa vence em breve: ${line(data.taskTitle)}`,
    html: baseTemplate({
      preheader: `A tarefa "${e.taskTitle}" vence em ${e.dueDate}.`,
      appUrl,
      content: `
        ${heading("Tarefa Vencendo em Breve")}
        ${paragraph(`A tarefa <strong style="color: ${TEXT_PRIMARY};">${e.taskTitle}</strong> vence em breve${leadTime ? ` (lembrete de ${leadTime} antes)` : ""}.`)}
        ${infoTable(`
          ${infoRow("Tarefa", e.taskTitle)}
          ${infoRow("Vencimento", e.dueDate)}
        `)}
        ${ctaButton("Ver Tarefa", taskUrl)}
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
  const e = escapeStrings(data);
  const appUrl = data.leadUrl.replace(/\/app\/.*$/, "");
  return {
    subject: `Lead atribuido: ${line(data.leadTitle)}`,
    html: baseTemplate({
      preheader: `${e.assignedByName} atribuiu o lead "${e.leadTitle}" a voce.`,
      appUrl,
      content: `
        ${heading("Lead Atribuido")}
        ${paragraph(`<strong style="color: ${TEXT_PRIMARY};">${e.assignedByName}</strong> atribuiu um lead a voce.`)}
        ${infoTable(`
          ${infoRow("Lead", e.leadTitle)}
          ${e.contactName ? infoRow("Contato", e.contactName) : ""}
          ${e.value ? infoRow("Valor", e.value) : ""}
          ${e.stage ? infoRow("Estagio", e.stage) : ""}
        `)}
        ${ctaButton("Ver Lead", data.leadUrl)}
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
  const e = escapeStrings(data);
  return {
    subject: `Resumo diario - ${line(data.date)}`,
    html: baseTemplate({
      preheader: `Resumo de ${e.orgName}: ${e.newLeadsCount} novos leads, ${e.completedTasksCount} tarefas concluidas.`,
      appUrl: data.appUrl,
      content: `
        ${heading(`Resumo Diario - ${e.date}`)}
        ${paragraph(`Aqui esta o resumo das atividades de ontem em <strong style="color: ${TEXT_PRIMARY};">${e.orgName}</strong>.`)}
        <table cellpadding="0" cellspacing="0" role="presentation" style="width: 100%; margin-top: 16px;">
          <tr>
            <td style="width: 50%; padding: 12px; text-align: center; background: ${BG_SOFT}; border-radius: 8px;">
              <div style="font-size: 28px; font-weight: 700; color: ${BRAND_LINK};">${e.newLeadsCount}</div>
              <div style="font-size: 12px; color: ${TEXT_SECONDARY}; margin-top: 4px;">Novos leads</div>
            </td>
            <td style="width: 8px;"></td>
            <td style="width: 50%; padding: 12px; text-align: center; background: ${BG_SOFT}; border-radius: 8px;">
              <div style="font-size: 28px; font-weight: 700; color: ${OK_COLOR};">${e.completedTasksCount}</div>
              <div style="font-size: 12px; color: ${TEXT_SECONDARY}; margin-top: 4px;">Tarefas concluidas</div>
            </td>
          </tr>
          <tr><td colspan="3" style="height: 8px;"></td></tr>
          <tr>
            <td style="width: 50%; padding: 12px; text-align: center; background: ${BG_SOFT}; border-radius: 8px;">
              <div style="font-size: 28px; font-weight: 700; color: ${WARN_COLOR};">${e.pendingHandoffsCount}</div>
              <div style="font-size: 12px; color: ${TEXT_SECONDARY}; margin-top: 4px;">Pedidos de ajuda pendentes</div>
            </td>
            <td style="width: 8px;"></td>
            <td style="width: 50%; padding: 12px; text-align: center; background: ${BG_SOFT}; border-radius: 8px;">
              <div style="font-size: 28px; font-weight: 700; color: ${e.overdueTasksCount > 0 ? BAD_COLOR : TEXT_SECONDARY};">${e.overdueTasksCount}</div>
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
  // `contactName`/`contactEmail` vêm de um formulário PÚBLICO e anônimo e caem
  // na caixa da equipe: sem escape, quem preenche injeta link/HTML no e-mail.
  const formName = escapeHtml(data.formName);
  return {
    subject: `Nova submissao de formulario: ${line(data.formName)}`,
    html: baseTemplate({
      preheader: `Uma nova submissao foi recebida no formulario "${formName}".`,
      appUrl,
      content: `
        ${heading("Nova Submissao de Formulario")}
        ${paragraph(`Uma nova submissao foi recebida no formulario <strong style="color: ${TEXT_PRIMARY};">${formName}</strong>.`)}
        ${infoTable(`
          ${infoRow("Formulario", formName)}
          ${data.contactEmail ? infoRow("E-mail", escapeHtml(data.contactEmail)) : ""}
          ${data.contactName ? infoRow("Contato", escapeHtml(data.contactName)) : ""}
        `)}
        ${ctaButton("Ver Lead", data.leadUrl)}
      `,
    }),
  };
}

export function buildFormConfirmationTemplate(data: {
  formName: string;
  subject?: string;
  body?: string;
  submittedData?: Record<string, string>;
  fieldLabels?: Record<string, string>;
}): TemplateResult {
  const subject = line(data.subject) || `Confirmacao: ${line(data.formName)}`;

  // Replace {variable} placeholders in body
  let bodyContent = escapeHtml(data.body || "Obrigado por preencher o formulario. Recebemos sua submissao com sucesso.");
  if (data.submittedData && data.fieldLabels) {
    for (const [fieldId, rawValue] of Object.entries(data.submittedData)) {
      // Valor digitado por quem preencheu: escapado, e via função de replace
      // para que um "$&" no valor não seja interpretado como padrão.
      const value = escapeHtml(String(rawValue ?? ""));
      const label = data.fieldLabels[fieldId];
      if (label) {
        bodyContent = bodyContent.replace(new RegExp(`\\{${escapeRegExp(escapeHtml(label))}\\}`, "gi"), () => value);
      }
      bodyContent = bodyContent.replace(new RegExp(`\\{${escapeRegExp(fieldId)}\\}`, "gi"), () => value);
    }
  }

  // Build data summary
  let dataSummary = "";
  if (data.submittedData && data.fieldLabels) {
    const rows = Object.entries(data.submittedData)
      .filter(([, v]) => String(v ?? "").trim())
      .map(([fieldId, value]) => {
        const label = data.fieldLabels![fieldId] || fieldId;
        return infoRow(escapeHtml(label), escapeHtml(String(value)));
      })
      .join("");
    if (rows) {
      dataSummary = infoTable(rows);
    }
  }

  return {
    subject,
    html: baseTemplate({
      preheader: `Confirmacao de envio: ${escapeHtml(data.formName)}`,
      appUrl: resolveAppUrl(),
      content: `
        ${heading("Confirmacao de Envio")}
        ${paragraph(bodyContent)}
        ${dataSummary}
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
    case "taskOverdueSummary":
      return buildTaskOverdueSummaryTemplate(data as any);
    case "taskAssigned":
      return buildTaskAssignedTemplate(data as any);
    case "taskCommentMention":
      return buildTaskCommentMentionTemplate(data as any);
    case "taskDueSoon":
      return buildTaskDueSoonTemplate(data as any);
    case "leadAssigned":
      return buildLeadAssignedTemplate(data as any);
    case "dailyDigest":
      return buildDailyDigestTemplate(data as any);
    case "formSubmission":
      return buildFormSubmissionTemplate(data as any);
    case "formConfirmation":
      return buildFormConfirmationTemplate(data as any);
    case "groupPostPending":
      return buildGroupPostPendingTemplate(data as any);
    case "groupPostFailed":
      return buildGroupPostFailedTemplate(data as any);
    case "aiSpendAlert":
      return buildAiSpendAlertTemplate(data as any);
    case "channelSessionLost":
      return buildChannelSessionLostTemplate(data as any);
    case "planAlert":
      return buildPlanAlertTemplate(data as any);
    default:
      // Fail-closed: um typo de eventType virava um e-mail vazio ("Evento: x")
      // entregue ao cliente. `dispatchNotification` captura e loga.
      throw new Error(`Template de e-mail desconhecido: ${eventType}`);
  }
}

// ── Publicações programadas em grupos (F3) ──
//
// O e-mail existe porque a aprovação é CONTRA O RELÓGIO: o texto foi gerado N
// minutos antes do horário e, se ninguém aprovar, o `onMissedApproval` decide.
// O sino sozinho não alcança quem não está com a aba aberta.

export function buildGroupPostPendingTemplate(data: {
  postName: string;
  postId?: string;
  groups?: string;
  scheduledFor: string;
  text: string;
  appUrl?: string;
  missedBehavior?: "skip" | "send";
}): TemplateResult {
  const e = escapeStrings(data);
  const appUrl = data.appUrl || resolveAppUrl();
  const postUrl = `${appUrl}/app/grupos?post=${data.postId ?? ""}`;
  const missed =
    e.missedBehavior === "send"
      ? "Sem resposta até o horário, o texto vai ser publicado do jeito que está."
      : "Sem resposta até o horário, a publicação deste horário é pulada.";
  return {
    subject: `Aprovar publicacao: ${line(data.postName)}`,
    html: baseTemplate({
      preheader: `A IA escreveu a publicacao "${e.postName}" para ${e.scheduledFor}.`,
      appUrl,
      content: `
        ${heading("Publicação esperando aprovação")}
        ${paragraph(`A IA escreveu o texto da publicação <strong style="color: ${TEXT_PRIMARY};">${e.postName}</strong>. ${missed}`)}
        ${infoTable(`
          ${infoRow("Publicação", e.postName)}
          ${infoRow("Horário", e.scheduledFor)}
          ${e.groups ? infoRow("Grupos", e.groups) : ""}
        `)}
        ${paragraph(`<em style="color: ${TEXT_SECONDARY};">${e.text.slice(0, 1200)}</em>`)}
        ${ctaButton("Revisar e aprovar", postUrl)}
      `,
    }),
  };
}

export function buildGroupPostFailedTemplate(data: {
  postName: string;
  postId?: string;
  reason: string;
  appUrl?: string;
}): TemplateResult {
  const e = escapeStrings(data);
  const appUrl = data.appUrl || resolveAppUrl();
  const postUrl = `${appUrl}/app/grupos?post=${data.postId ?? ""}`;
  return {
    subject: `Publicacao interrompida: ${line(data.postName)}`,
    html: baseTemplate({
      preheader: `A publicacao "${e.postName}" parou: ${e.reason}`,
      appUrl,
      content: `
        ${heading("Publicação interrompida")}
        ${paragraph(`A publicação <strong style="color: ${TEXT_PRIMARY};">${e.postName}</strong> não pôde continuar e foi pausada.`)}
        ${infoTable(`
          ${infoRow("Publicação", e.postName)}
          ${infoRow("Motivo", e.reason)}
        `)}
        ${ctaButton("Abrir publicação", postUrl)}
      `,
    }),
  };
}

// ── Gasto de IA do mês (v0.69, T04) ──
//
// Vai aos admins (settings:manage), 1×/mês por limiar. SEM PII: só números do
// mês e o nome da organização (escapado). Valores em R$ são APROXIMADOS (custo
// estimado em USD × cotação configurada) — o texto diz isso.

export function buildAiSpendAlertTemplate(data: {
  level: "warn" | "reached";
  orgName: string;
  month: string; // "AAAA-MM"
  costBrl: string; // já formatado, ex. "R$ 82,10"
  capBrl: string;
  pct: number;
  mode: "warn" | "block";
  appUrl?: string;
}): TemplateResult {
  const appUrl = data.appUrl || resolveAppUrl();
  const settingsUrl = `${appUrl}/app/configuracoes?secao=ai-usage`;
  const pct = Math.round(data.pct);
  const reached = data.level === "reached";
  const consequence = !reached
    ? "Nada muda por enquanto — é só um aviso para você acompanhar."
    : data.mode === "block"
      ? "O teto está no modo <strong>bloquear</strong>: o atendente passa a deixar respostas como RASCUNHO para a equipe revisar (e abre um pedido de ajuda), e os demais recursos de IA ficam suspensos até o próximo mês."
      : "O teto está no modo <strong>avisar</strong>: a IA continua funcionando normalmente. Se quiser que ela pare ao atingir o teto, mude o modo para bloquear.";
  const title = reached ? "Teto de gastos de IA atingido" : "Gasto de IA perto do teto";
  return {
    subject: reached
      ? `Teto de gastos de IA atingido (${line(data.month)})`
      : `Gasto de IA em ${pct}% do teto (${line(data.month)})`,
    html: baseTemplate({
      preheader: `${escapeHtml(data.orgName)}: ${pct}% do teto mensal de IA em ${escapeHtml(data.month)}.`,
      appUrl,
      content: `
        ${heading(title)}
        ${paragraph(`O gasto aproximado com IA de <strong style="color: ${TEXT_PRIMARY};">${escapeHtml(data.orgName)}</strong> chegou a ${pct}% do teto definido para o mês.`)}
        ${infoTable(`
          ${infoRow("Mês", escapeHtml(data.month))}
          ${infoRow("Gasto aproximado", escapeHtml(data.costBrl))}
          ${infoRow("Teto mensal", escapeHtml(data.capBrl))}
        `)}
        ${paragraph(consequence)}
        ${paragraph(`<em style="color: ${TEXT_SECONDARY};">Valores aproximados: custo estimado em dólar convertido pela cotação configurada.</em>`)}
        ${ctaButton("Ver uso e teto", settingsUrl)}
      `,
    }),
  };
}

/** Avisos de plano (B4): o texto vem pronto do `notificationCopy` (mesmo do sino). */
export function buildPlanAlertTemplate(data: {
  orgName: string;
  title: string;
  body?: string;
  appUrl?: string;
}): TemplateResult {
  const appUrl = data.appUrl || resolveAppUrl();
  return {
    subject: `${line(data.title)} (${line(data.orgName)})`,
    html: baseTemplate({
      preheader: `${escapeHtml(data.orgName)}: ${escapeHtml(data.title)}`,
      appUrl,
      content: `
        ${heading(escapeHtml(data.title))}
        ${data.body ? paragraph(escapeHtml(data.body)) : ""}
        ${ctaButton("Ver uso e plano", `${appUrl}/app/configuracoes?secao=billing`)}
      `,
    }),
  };
}

const SESSION_STATE_LABELS: Record<string, string> = {
  logged_out: "Deslogado (o número foi desconectado no aparelho)",
  temporarily_banned: "Banimento temporário do WhatsApp",
  banned: "Número banido pelo WhatsApp",
  outdated: "Gateway desatualizado (o WhatsApp recusou a conexão)",
  disconnected: "Fora do ar",
};

export function buildChannelSessionLostTemplate(data: {
  orgName: string;
  channelName: string;
  phoneDisplay?: string; // já mascarado
  state: string;
  detail?: string;
  expiresAt?: number;
  pausedCampaigns?: number;
  pausedGroupPosts?: number;
  /** "meta_messaging" = Instagram/Messenger (F4): cópia neutra, sem "WhatsApp". */
  provider?: string;
  appUrl?: string;
}): TemplateResult {
  const appUrl = data.appUrl || resolveAppUrl();
  const url = `${appUrl}/app/configuracoes?secao=${data.provider === "meta_messaging" ? "instagram" : "channels"}`;
  if (data.provider === "meta_messaging") {
    const expiring = data.state === "data_access_expiring";
    const name = maskDigitRuns(data.channelName);
    const revoked = data.state === "revoked";
    return {
      subject: revoked
        ? `A autorização de ${name} foi removida`
        : expiring ? `Reconecte ${name} para manter o acesso` : `${name} precisa ser reconectada`,
      html: baseTemplate({
        preheader: `${escapeHtml(data.orgName)}: ${expiring ? "reconecte" : "a conexão precisa ser refeita"} — ${escapeHtml(name)}.`,
        appUrl,
        content: `
        ${heading(expiring ? "Reconecte para manter o acesso" : revoked ? "Autorização removida" : "Conta precisa ser reconectada")}
        ${paragraph(
          expiring
            ? `O acesso de <strong style="color: ${TEXT_PRIMARY};">${escapeHtml(name)}</strong> às mensagens de ${escapeHtml(data.orgName)} está perto de expirar. Reconecte a conta para continuar sem interrupção.`
            : `A conta <strong style="color: ${TEXT_PRIMARY};">${escapeHtml(name)}</strong> de ${escapeHtml(data.orgName)} precisa ser reconectada. Enquanto isso, não é possível enviar mensagens por ela.`
        )}
        ${data.detail ? paragraph(escapeHtml(data.detail)) : ""}
        ${ctaButton("Ver canais", url)}
      `,
      }),
    };
  }
  const label = data.phoneDisplay ? `${data.channelName} (${data.phoneDisplay})` : data.channelName;
  const stateLabel = SESSION_STATE_LABELS[data.state] ?? "Sem conexão";
  const paused: string[] = [];
  if (data.pausedCampaigns) paused.push(`${data.pausedCampaigns} campanha(s)`);
  if (data.pausedGroupPosts) paused.push(`${data.pausedGroupPosts} publicação(ões) em grupo`);
  const expires = data.expiresAt
    ? new Date(data.expiresAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
    : "";
  return {
    subject: `WhatsApp ${maskDigitRuns(label)} perdeu a conexão`,
    html: baseTemplate({
      preheader: `${escapeHtml(data.orgName)}: o WhatsApp "${escapeHtml(maskDigitRuns(data.channelName))}" perdeu a conexão.`,
      appUrl,
      content: `
        ${heading("WhatsApp desconectado")}
        ${paragraph(`O número de WhatsApp <strong style="color: ${TEXT_PRIMARY};">${escapeHtml(maskDigitRuns(label))}</strong> de ${escapeHtml(data.orgName)} não está enviando nem recebendo mensagens.`)}
        ${infoTable(`
          ${infoRow("Empresa", escapeHtml(data.orgName))}
          ${infoRow("Canal", escapeHtml(maskDigitRuns(label)))}
          ${infoRow("Situação", escapeHtml(stateLabel))}
          ${expires ? infoRow("Libera em", escapeHtml(expires)) : ""}
          ${paused.length ? infoRow("Pausado", escapeHtml(paused.join(" e "))) : ""}
        `)}
        ${data.detail ? paragraph(escapeHtml(data.detail)) : ""}
        ${ctaButton("Ver canais", url)}
      `,
    }),
  };
}
