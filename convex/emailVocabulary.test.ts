/**
 * Guarda de texto dos e-mails: renderiza todos os modelos com dados de exemplo e falha se o
 * assunto ou o texto visível (HTML sem tags e sem `href`) trouxer vocabulário antigo do produto
 * (`src/lib/vocab.ts`) ou palavras sem acento já corrigidas. Modelo novo entra em `SAMPLES`.
 */
import { describe, expect, test } from "vitest";
import {
  buildAddedToOrgTemplate,
  buildEmailVerificationTemplate,
  buildPasswordResetTemplate,
  buildWelcomeTemplate,
} from "./authEmailTemplates";
import { buildTemplate, type TemplateResult } from "./emailTemplates";

const URL_BASE = "https://hnbcrm.com";

const SAMPLES: Record<string, TemplateResult> = {
  invite: buildTemplate("invite", { memberName: "Ana", orgName: "Clínica Aurora", email: "ana@exemplo.com.br", tempPassword: "Abc12345", loginUrl: `${URL_BASE}/entrar` }),
  handoffRequested: buildTemplate("handoffRequested", { orgName: "Clínica Aurora", leadTitle: "Marina Costa", origin: "ai_tool", reason: "Quer falar com alguém", fromIsHuman: true, fromMemberName: "Atendente IA", leadUrl: `${URL_BASE}/app/repasses?handoff=abc` }),
  handoffRequestedMany: buildTemplate("handoffRequested", { leadTitle: "Marina Costa", origin: "ai_budget", pendingLabel: "3", fromMemberName: "Atendente IA", leadUrl: `${URL_BASE}/app/repasses?handoff=abc` }),
  handoffResolvedAccepted: buildTemplate("handoffResolved", { leadTitle: "Marina Costa", status: "aceito", resolvedByName: "Carlos", leadUrl: `${URL_BASE}/app/repasses` }),
  handoffResolvedRejected: buildTemplate("handoffResolved", { leadTitle: "Marina Costa", status: "rejeitado", resolvedByName: "Carlos", leadUrl: `${URL_BASE}/app/repasses` }),
  taskOverdue: buildTemplate("taskOverdue", { taskTitle: "Ligar para o cliente", dueDate: "10/11/2026", leadTitle: "Marina Costa", taskUrl: `${URL_BASE}/app/tarefas` }),
  taskOverdueSummary: buildTemplate("taskOverdueSummary", { count: 5, tasks: [{ title: "Ligar", dueDate: "10/11/2026", taskUrl: `${URL_BASE}/app/tarefas` }], appUrl: URL_BASE }),
  taskAssigned: buildTemplate("taskAssigned", { taskTitle: "Enviar proposta", dueDate: "12/11/2026", assignedByName: "Carlos", leadTitle: "Marina Costa", taskUrl: `${URL_BASE}/app/tarefas` }),
  taskCommentMention: buildTemplate("taskCommentMention", { authorName: "Carlos", taskTitle: "Enviar proposta", commentExcerpt: "Pode olhar?", appUrl: URL_BASE }),
  taskDueSoon: buildTemplate("taskDueSoon", { taskTitle: "Enviar proposta", dueDate: "12/11/2026 15:00", minutesBefore: 15, appUrl: URL_BASE }),
  leadAssigned: buildTemplate("leadAssigned", { leadTitle: "Marina Costa", value: "R$ 1.000,00", stage: "Proposta", contactName: "Marina", assignedByName: "Carlos", leadUrl: `${URL_BASE}/app/funil` }),
  dailyDigest: buildTemplate("dailyDigest", { date: "11/11/2026", orgName: "Clínica Aurora", newLeadsCount: 7, completedTasksCount: 4, pendingHandoffsCount: 2, overdueTasksCount: 1, appUrl: URL_BASE }),
  formSubmission: buildTemplate("formSubmission", { formName: "Contato do site", contactEmail: "m@exemplo.com.br", contactName: "Marina", leadUrl: `${URL_BASE}/app/funil` }),
  formConfirmation: buildTemplate("formConfirmation", { formName: "Contato do site" }),
  groupPostPending: buildTemplate("groupPostPending", { postName: "Promoção da semana", groups: "Clientes", scheduledFor: "12/11/2026 09:00", text: "Texto da publicação", appUrl: URL_BASE }),
  groupPostPendingSend: buildTemplate("groupPostPending", { postName: "Promoção da semana", scheduledFor: "12/11/2026 09:00", text: "Texto", missedBehavior: "send", appUrl: URL_BASE }),
  groupPostFailed: buildTemplate("groupPostFailed", { postName: "Promoção da semana", reason: "Canal sem conexão", appUrl: URL_BASE }),
  aiSpendWarn: buildTemplate("aiSpendAlert", { level: "warn", orgName: "Clínica Aurora", month: "2026-11", costBrl: "R$ 82,10", capBrl: "R$ 100,00", pct: 82, mode: "warn", appUrl: URL_BASE }),
  aiSpendBlock: buildTemplate("aiSpendAlert", { level: "reached", orgName: "Clínica Aurora", month: "2026-11", costBrl: "R$ 100,00", capBrl: "R$ 100,00", pct: 100, mode: "block", appUrl: URL_BASE }),
  aiSpendReachedWarnMode: buildTemplate("aiSpendAlert", { level: "reached", orgName: "Clínica Aurora", month: "2026-11", costBrl: "R$ 100,00", capBrl: "R$ 100,00", pct: 100, mode: "warn", appUrl: URL_BASE }),
  planAlert: buildTemplate("planAlert", { orgName: "Clínica Aurora", title: "Você usou 80% do plano", body: "Faltam poucos atendimentos neste mês.", appUrl: URL_BASE }),
  ...Object.fromEntries(
    ["logged_out", "temporarily_banned", "banned", "outdated", "disconnected", "outro"].map((state) => [
      `channelSessionLost_${state}`,
      buildTemplate("channelSessionLost", { orgName: "Clínica Aurora", channelName: "Principal", phoneDisplay: "••••1234", state, expiresAt: 1_800_000_000_000, pausedCampaigns: 1, pausedGroupPosts: 2, appUrl: URL_BASE }),
    ]),
  ),
  ...Object.fromEntries(
    ["revoked", "data_access_expiring", "reauth_required"].map((state) => [
      `channelSessionLost_meta_${state}`,
      buildTemplate("channelSessionLost", { orgName: "Clínica Aurora", channelName: "@clinica", state, provider: "meta_messaging", appUrl: URL_BASE }),
    ]),
  ),
  passwordReset: buildPasswordResetTemplate({ code: "12345678", expiresMinutes: 15 }),
  emailVerification: buildEmailVerificationTemplate({ code: "123456", expiresMinutes: 10 }),
  welcome: buildWelcomeTemplate({ memberName: "Ana Souza", orgName: "Clínica Aurora", appUrl: URL_BASE }),
  welcomeNoName: buildWelcomeTemplate({ memberName: "", orgName: "Clínica Aurora", appUrl: URL_BASE }),
  addedToOrg: buildAddedToOrgTemplate({ memberName: "Ana", orgName: "Clínica Aurora", invitedByName: "Carlos", appUrl: URL_BASE }),
  addedToOrgTemp: buildAddedToOrgTemplate({ memberName: "Ana", orgName: "Clínica Aurora", pendingPasswordChange: true, appUrl: URL_BASE }),
};

/** Texto que a pessoa lê: sem `<style>`, sem `href`/`src` (URLs), sem tags, entidades básicas decodificadas. */
function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<title[\s\S]*?<\/title>/gi, " ")
    .replace(/\s(href|src)="[^"]*"/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;|&#39;|&amp;/g, " ")
    .replace(/\s+/g, " ");
}

/** Vocabulário antigo (`BANNED_UI_TERMS`) e grafias sem acento já corrigidas. Sem distinção de maiúsculas. */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/repasse/i, "repasse (use pedido de ajuda / Requer atenção)"],
  [/pipeline/i, "pipeline (use funil)"],
  [/\bgateway\b/i, "gateway"],
  [/\bbridge\b/i, "bridge"],
  [/\bautopilot\b/i, "autopilot"],
  [/\bestágios?\b|\bestagios?\b/i, "estágio (use etapa)"],
  [/(^|[^-\w])email\b/i, "email sem hífen (use e-mail)"],
  [/\bvoce\b/i, "voce"],
  [/\bnao\b/i, "nao"],
  [/\batribuid[ao]s?\b/i, "atribuida sem acento"],
  [/\bconcluidas?\b/i, "concluidas"],
  [/formulario/i, "formulario"],
  [/submiss(ao|oes)\b/i, "submissao"],
  [/organizacao/i, "organizacao"],
  [/\bcodigo\b/i, "codigo"],
  [/\bnumero\b/i, "numero"],
  [/\btambem\b/i, "tambem"],
  [/\bconexao\b/i, "conexao"],
  [/\busuario\b/i, "usuario"],
  [/\bproximos?\b/i, "proximos"],
  [/\batencao\b/i, "atencao"],
  [/\bdiario\b/i, "diario"],
  [/\bconfirmacao\b/i, "confirmacao"],
  [/publicacao/i, "publicacao"],
  [/ com sucesso/i, "com sucesso"],
];

describe("vocabulário e ortografia dos e-mails", () => {
  test.each(Object.entries(SAMPLES))("%s", (_name, tpl) => {
    expect(tpl.subject.length).toBeGreaterThan(0);
    const text = `${tpl.subject} || ${visibleText(tpl.html)}`;
    for (const [pattern, label] of FORBIDDEN) {
      expect(text.match(pattern)?.[0] ?? null, `termo proibido: ${label}`).toBeNull();
    }
  });

  test("o guarda não acusa URLs (href) com /app/repasses", () => {
    const t = SAMPLES.handoffRequested;
    expect(t.html).toContain("/app/repasses");
    expect(visibleText(t.html)).not.toMatch(/repasse/i);
  });

  test("assuntos do pedido de ajuda", () => {
    expect(SAMPLES.handoffRequested.subject).toBe("Pedido de ajuda: Marina Costa");
    expect(SAMPLES.handoffRequestedMany.subject).toBe("Novo pedido de ajuda (3 pendentes)");
    expect(SAMPLES.handoffResolvedAccepted.subject).toBe("Pedido de ajuda aceito: Marina Costa");
  });
});
