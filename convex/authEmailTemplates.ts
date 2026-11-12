// Templates de e-mail dos fluxos de autenticação (redefinir senha, boas-
// vindas). Puro TypeScript, sem APIs de Node — reusa o layout de
// convex/emailTemplates.ts (baseTemplate/ctaButton/heading/paragraph/
// escapeHtml, exportados de lá só para isso) para manter a mesma cara dos
// demais e-mails do produto.
import { appUrl } from "./lib/appUrl";
import {
  baseTemplate,
  ctaButton,
  escapeHtml,
  heading,
  line,
  safeUrl,
  paragraph,
  type TemplateResult,
} from "./emailTemplates";

// Cores do tema claro "Estilo WhatsApp" (mesmos valores de emailTemplates.ts; o modo escuro do
// cliente é tratado lá por seletor de atributo sobre estes valores).
const BG_SOFT = "#F0F2F5";
const TEXT_PRIMARY = "#111B21";
const TEXT_SECONDARY = "#54656F";
const BORDER_COLOR = "#E9EDEF";
const CODE_COLOR = "#006B58";

/**
 * E-mail com o código de redefinição de senha (fluxo "reset" do Password
 * provider do Convex Auth — convex/passwordReset.ts). `code` já vem pronto
 * do gerador (8 dígitos numéricos); escapamos mesmo assim por padrão de
 * defesa em profundidade, já que ele viaja para dentro de HTML.
 */
export function buildPasswordResetTemplate(data: {
  code: string;
  expiresMinutes: number;
}): TemplateResult {
  const base = appUrl();
  return {
    subject: "Código para redefinir sua senha",
    html: baseTemplate({
      preheader: `Seu código de redefinição de senha é ${data.code}.`,
      appUrl: base,
      content: `
        ${heading("Redefinir senha")}
        ${paragraph("Recebemos um pedido para redefinir a senha da sua conta no HNBCRM. Use o código abaixo na tela de redefinição.")}
        <div style="margin: 24px 0; text-align: center;">
          <span style="display: inline-block; padding: 16px 32px; background: ${BG_SOFT}; border: 1px solid ${BORDER_COLOR}; border-radius: 8px; font-size: 32px; font-weight: 700; letter-spacing: 8px; color: ${CODE_COLOR};">${escapeHtml(data.code)}</span>
        </div>
        ${paragraph(`Esse código expira em ${data.expiresMinutes} minutos.`)}
        ${paragraph("Se você não pediu essa redefinição, pode ignorar este e-mail — sua senha continua a mesma.")}
      `,
    }),
  };
}

/**
 * E-mail com o código de 6 dígitos para confirmar o e-mail da conta (onboarding
 * v2). Sem link: o usuário digita o código na tela. `code` é numérico, mas passa
 * por escapeHtml por defesa em profundidade.
 */
export function buildEmailVerificationTemplate(data: {
  code: string;
  expiresMinutes: number;
}): TemplateResult {
  const base = appUrl();
  return {
    subject: "Seu código de confirmação do HNBCRM",
    html: baseTemplate({
      preheader: `Seu código de confirmação é ${data.code}.`,
      appUrl: base,
      content: `
        ${heading("Confirme seu e-mail")}
        ${paragraph("Use o código abaixo no HNBCRM para confirmar o seu e-mail e liberar o envio de materiais.")}
        <div style="margin: 24px 0; text-align: center;">
          <span style="display: inline-block; padding: 16px 32px; background: ${BG_SOFT}; border: 1px solid ${BORDER_COLOR}; border-radius: 8px; font-size: 32px; font-weight: 700; letter-spacing: 8px; color: ${CODE_COLOR};">${escapeHtml(data.code)}</span>
        </div>
        ${paragraph(`Esse código expira em ${data.expiresMinutes} minutos.`)}
        ${paragraph("Se você não pediu este código, pode ignorar este e-mail.")}
      `,
    }),
  };
}

/**
 * E-mail de boas-vindas, disparado ao criar uma organização (o admin que
 * acabou de se cadastrar — ver organizations.ts → createOrganization).
 * `memberName`/`orgName` são digitados pelo usuário no cadastro, então
 * passam por escapeHtml.
 */
export function buildWelcomeTemplate(data: {
  memberName: string;
  orgName: string;
  appUrl: string;
}): TemplateResult {
  const firstName = welcomeFirstName(data.memberName);
  const orgName = escapeHtml(data.orgName);
  const hello = firstName ? `Bem-vindo(a) ao HNBCRM, ${escapeHtml(firstName)}!` : "Bem-vindo(a) ao HNBCRM!";
  const startUrl = `${data.appUrl}/comecar`;
  const steps = [
    `<a href="${safeUrl(startUrl)}" style="color: #006B58; font-weight: 600;">Conte sobre o seu negócio</a> para o Copiloto montar a operação`,
    "Teste a sua IA no simulador antes de conectar um número",
    "Conecte o WhatsApp e convide a equipe",
  ];
  const stepsList = `<ol style="margin: 16px 0 0; padding-left: 20px; color: ${TEXT_SECONDARY}; font-size: 15px; line-height: 1.9;">
    ${steps.map((step) => `<li style="margin-bottom: 4px;">${step}</li>`).join("")}
  </ol>`;
  return {
    subject: firstName ? `Bem-vindo ao HNBCRM, ${line(firstName)}!` : "Bem-vindo ao HNBCRM!",
    html: baseTemplate({
      preheader: `${firstName ? escapeHtml(firstName) + ", s" : "S"}ua organização ${orgName} já está pronta no HNBCRM.`,
      appUrl: data.appUrl,
      content: `
        ${heading(hello)}
        ${paragraph(`Sua organização <strong style="color: ${TEXT_PRIMARY};">${orgName}</strong> já está pronta. Aqui vão os primeiros passos:`)}
        ${stepsList}
        ${ctaButton("Abrir o HNBCRM", `${data.appUrl}/app`)}
      `,
    }),
  };
}

/** Primeiro nome para a saudação; vazio quando o "nome" falta ou é o próprio e-mail (nunca mostrar e-mail). */
function welcomeFirstName(raw: string): string {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!name || name.includes("@")) return "";
  return name;
}

/**
 * Aviso a quem JÁ tinha conta e foi adicionado a mais uma organização (o
 * convite de conta nova usa o template "invite", com senha temporária). Sem
 * isto a pessoa nunca descobria a org nova: o seletor lembra a org anterior.
 * `orgName`/`invitedByName` são texto de usuário → escapeHtml.
 */
export function buildAddedToOrgTemplate(data: {
  memberName: string;
  orgName: string;
  invitedByName?: string;
  pendingPasswordChange?: boolean;
  appUrl: string;
}): TemplateResult {
  const memberName = escapeHtml(data.memberName);
  const orgName = escapeHtml(data.orgName);
  const by = data.invitedByName ? ` por ${escapeHtml(data.invitedByName)}` : "";
  return {
    // Assunto é texto puro: vai sem escape (entidade apareceria crua).
    subject: `Você foi adicionado(a) à organização ${data.orgName} no HNBCRM`,
    html: baseTemplate({
      preheader: `${memberName}, você agora faz parte de ${orgName} no HNBCRM.`,
      appUrl: data.appUrl,
      content: `
        ${heading(`Olá, ${memberName}!`)}
        ${paragraph(`Você foi adicionado(a)${by} à organização <strong style="color: ${TEXT_PRIMARY};">${orgName}</strong> no HNBCRM.`)}
        ${paragraph(
          data.pendingPasswordChange
            ? "Entre com o seu e-mail e a senha temporária que você recebeu no primeiro convite (ou use \"Esqueci a senha\" na tela de entrada). Você vai criar uma senha nova no primeiro acesso e depois escolher a organização no seletor."
            : "Entre com o mesmo e-mail e a mesma senha de sempre e escolha a organização no seletor."
        )}
        ${ctaButton("Abrir o HNBCRM", `${data.appUrl}/app`)}
      `,
    }),
  };
}
