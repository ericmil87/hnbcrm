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
  paragraph,
  type TemplateResult,
} from "./emailTemplates";

// Cores do tema escuro do HNBCRM — emailTemplates.ts não exporta essas
// constantes (só funções), então repetimos os mesmos valores aqui.
const BRAND_ORANGE = "#EA580C";
const BG_DARK = "#0d0d0d";
const TEXT_PRIMARY = "#f5f5f5";
const TEXT_SECONDARY = "#a3a3a3";
const BORDER_COLOR = "#2a2a2a";

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
          <span style="display: inline-block; padding: 16px 32px; background: ${BG_DARK}; border: 1px solid ${BORDER_COLOR}; border-radius: 8px; font-size: 32px; font-weight: 700; letter-spacing: 8px; color: ${BRAND_ORANGE};">${escapeHtml(data.code)}</span>
        </div>
        ${paragraph(`Esse código expira em ${data.expiresMinutes} minutos.`)}
        ${paragraph("Se você não pediu essa redefinição, pode ignorar este e-mail — sua senha continua a mesma.")}
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
  const memberName = escapeHtml(data.memberName);
  const orgName = escapeHtml(data.orgName);
  const steps = [
    "Conecte o WhatsApp em Configurações → Canais",
    "Monte o funil de vendas do jeito que sua equipe trabalha",
    "Convide o resto da equipe para entrar",
  ];
  const stepsList = `<ol style="margin: 16px 0 0; padding-left: 20px; color: ${TEXT_SECONDARY}; font-size: 14px; line-height: 2;">
    ${steps.map((step) => `<li>${step}</li>`).join("")}
  </ol>`;
  return {
    subject: `Bem-vindo ao HNBCRM, ${memberName}!`,
    html: baseTemplate({
      preheader: `${memberName}, sua organização ${orgName} já está pronta no HNBCRM.`,
      appUrl: data.appUrl,
      content: `
        ${heading(`Bem-vindo(a) ao HNBCRM, ${memberName}!`)}
        ${paragraph(`Sua organização <strong style="color: ${TEXT_PRIMARY};">${orgName}</strong> já está pronta. Aqui vão os primeiros passos:`)}
        ${stepsList}
        ${ctaButton("Abrir o HNBCRM", `${data.appUrl}/app`)}
      `,
    }),
  };
}
