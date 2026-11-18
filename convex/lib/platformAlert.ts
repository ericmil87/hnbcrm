/**
 * Alerta de PLATAFORMA por e-mail (problema da infraestrutura do HNBCRM, não
 * de uma org: chave de provedor recusada, crédito acabou, limite atingido…).
 * Porta única e reutilizável: qualquer módulo chama `platformAlert(ctx, …)` de
 * dentro de uma mutation.
 *
 * - Destinatário: env `PLATFORM_ALERT_EMAIL` (ausente = não envia e NÃO
 *   carimba, para o 1º alerta sair assim que a env for configurada). Nunca
 *   hardcode no repo.
 * - Dedupe por `kind`: no máximo 1 e-mail por `kind` a cada `throttleMs`
 *   (default 6 h); as ocorrências suprimidas são contadas e citadas no próximo.
 * - Envio só por `sendTransactionalEmail` (respeita o `RESEND_TEST_MODE` do DEV
 *   e a lista de supressão).
 * - Conteúdo: o chamador manda texto já seguro (sem chave, sem dado de
 *   cliente); aqui tudo passa por `escapeHtml`.
 */
import type { MutationCtx } from "../_generated/server";
import { sendTransactionalEmail } from "../email";
import { escapeHtml } from "../emailTemplates";

export const DEFAULT_PLATFORM_ALERT_THROTTLE_MS = 6 * 3_600_000;

export type PlatformAlertSeverity = "critical" | "warning";

export type PlatformAlertInput = {
  /** Chave de dedupe, estável e curta (ex. "groq_auth", "openrouter_no_credit"). */
  kind: string;
  severity: PlatformAlertSeverity;
  /** Assunto curto em PT-BR (vai depois de "[HNBCRM]"). */
  title: string;
  /** O que aconteceu, em PT-BR, sem segredo nem dado de cliente. */
  detail: string;
  /** Como resolver (opcional). */
  howToFix?: string;
  /** O que continua funcionando enquanto isso (opcional). */
  fallback?: string;
  /** Janela do dedupe; default 6 h. */
  throttleMs?: number;
};

export type PlatformAlertResult = { sent: boolean; reason?: "no_recipient" | "throttled" | "send_failed" };

/** Decisão pura do dedupe. */
export function platformAlertDue(lastSentAt: number | undefined, now: number, throttleMs: number): boolean {
  return lastSentAt === undefined || now - lastSentAt >= throttleMs;
}

/** Rótulo do deployment (subdomínio do CONVEX_CLOUD_URL), para separar DEV de PROD no e-mail. */
export function deploymentLabel(): string {
  const m = (process.env.CONVEX_CLOUD_URL ?? "").match(/^https?:\/\/([^.]+)\./);
  return m ? m[1]! : "desconhecido";
}

export function buildPlatformAlertEmail(
  input: PlatformAlertInput,
  extra: { deployment: string; suppressed: number; throttleMs: number }
): { subject: string; html: string } {
  const e = escapeHtml;
  const tag = input.severity === "critical" ? "[HNBCRM][CRÍTICO]" : "[HNBCRM]";
  const hours = Math.max(1, Math.round(extra.throttleMs / 3_600_000));
  return {
    subject: `${tag} ${input.title}`.slice(0, 160),
    html:
      `<p><strong>${e(input.detail)}</strong></p>` +
      (input.howToFix ? `<p><strong>Como resolver:</strong> ${e(input.howToFix)}</p>` : "") +
      (input.fallback ? `<p>${e(input.fallback)}</p>` : "") +
      (extra.suppressed > 0
        ? `<p>O mesmo problema aconteceu mais ${extra.suppressed} vez(es) desde o último aviso.</p>`
        : "") +
      `<p style="color:#666">Deployment: ${e(extra.deployment)}. Tipo: ${e(input.kind)}. ` +
      `Este aviso se repete no máximo a cada ${hours} h por tipo.</p>`,
  };
}

/**
 * Registra a ocorrência e, se a janela permitir, manda o e-mail. Seguro de
 * chamar a cada falha: o dedupe vive em `platformAlerts` (uma linha por kind).
 */
export async function platformAlert(ctx: MutationCtx, input: PlatformAlertInput): Promise<PlatformAlertResult> {
  const now = Date.now();
  const throttleMs = input.throttleMs ?? DEFAULT_PLATFORM_ALERT_THROTTLE_MS;
  const recipient = process.env.PLATFORM_ALERT_EMAIL?.trim();
  const kind = input.kind.slice(0, 80);
  const row = await ctx.db
    .query("platformAlerts")
    .withIndex("by_kind", (q) => q.eq("kind", kind))
    .unique();

  if (!recipient) return { sent: false, reason: "no_recipient" };

  if (!platformAlertDue(row?.lastSentAt, now, throttleMs)) {
    if (row) await ctx.db.patch(row._id, { suppressedCount: (row.suppressedCount ?? 0) + 1, updatedAt: now });
    return { sent: false, reason: "throttled" };
  }

  const suppressed = row?.suppressedCount ?? 0;
  // Carimba ANTES de enviar (padrão dos alertas do projeto): falha de envio não
  // vira rajada de e-mails na próxima ocorrência.
  if (row) {
    await ctx.db.patch(row._id, { lastSentAt: now, suppressedCount: 0, lastSeverity: input.severity, updatedAt: now });
  } else {
    await ctx.db.insert("platformAlerts", { kind, lastSentAt: now, suppressedCount: 0, lastSeverity: input.severity, updatedAt: now });
  }
  const { subject, html } = buildPlatformAlertEmail(input, { deployment: deploymentLabel(), suppressed, throttleMs });
  const ok = await sendTransactionalEmail(ctx, { to: recipient, subject, html, kind: `platform_alert:${kind}` });
  return ok ? { sent: true } : { sent: false, reason: "send_failed" };
}
