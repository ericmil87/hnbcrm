/**
 * Alerta de PLATAFORMA por e-mail (problema da infraestrutura do HNBCRM, não
 * de uma org: chave de provedor recusada, crédito acabou, limite atingido…).
 * Porta única e reutilizável: qualquer módulo chama `platformAlert(ctx, …)` de
 * dentro de uma mutation; de uma action (inclusive "use node"), use o wrapper
 * `internal.platformAlerts.internalRaise`. Convenção de `kind`:
 * `<provedor>_<tipo>` em snake_case ("groq_auth", "openrouter_no_credit").
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
  /** Condição observada (platformCondition): desde quando o problema está ativo. */
  activeSince?: number;
};

/** "há 2 h" / "há 35 min" (para o lembrete de uma condição ativa). */
export function formatElapsed(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes >= 120 ? `${Math.round(minutes / 60)} h` : `${minutes} min`;
}

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
  extra: { deployment: string; suppressed: number; throttleMs: number; now?: number }
): { subject: string; html: string } {
  const e = escapeHtml;
  const tag = input.severity === "critical" ? "[HNBCRM][CRÍTICO]" : "[HNBCRM]";
  const hours = Math.max(1, Math.round(extra.throttleMs / 3_600_000));
  const now = extra.now ?? Date.now();
  // Condição: o lembrete diz há quanto tempo o problema dura (o contador de
  // suprimidos ali contaria observações do cron, não ocorrências).
  const repeat =
    input.activeSince !== undefined
      ? now - input.activeSince >= 60_000
        ? `<p>Problema ativo há ${e(formatElapsed(now - input.activeSince))}. Você recebe um aviso de "resolvido" quando ele sumir.</p>`
        : `<p>Você recebe um aviso de "resolvido" quando o problema sumir.</p>`
      : extra.suppressed > 0
        ? `<p>O mesmo problema aconteceu mais ${extra.suppressed} vez(es) desde o último aviso.</p>`
        : "";
  return {
    subject: `${tag} ${input.title}`.slice(0, 160),
    html:
      `<p><strong>${e(input.detail)}</strong></p>` +
      (input.howToFix ? `<p><strong>Como resolver:</strong> ${e(input.howToFix)}</p>` : "") +
      (input.fallback ? `<p>${e(input.fallback)}</p>` : "") +
      repeat +
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

// ── Condições com estado (sentinela, `convex/platformSentinel.ts`) ──────────

/** Observações boas seguidas antes do "resolvido" (histerese contra oscilação). */
export const DEFAULT_MIN_OK_STREAK = 2;

export type PlatformConditionInput = PlatformAlertInput & {
  /** Resultado desta observação: true = problema presente. */
  failing: boolean;
  /** Observações ruins SEGUIDAS antes do 1º e-mail (anti-oscilação); default 1. */
  minStreak?: number;
  /** Observações boas SEGUIDAS para dar o problema ALERTADO como resolvido; default 2. */
  minOkStreak?: number;
  /** Texto do e-mail de "resolvido" (default genérico). */
  recoveredDetail?: string;
};

export type PlatformConditionResult =
  | { state: "ok" }
  | { state: "recovering"; okStreak: number }
  | { state: "recovered"; notified: boolean }
  | { state: "pending"; streak: number }
  | { state: "alerting"; alert: PlatformAlertResult };

/**
 * Decisão pura da condição (testada sem banco). Sem alerta ativo, uma
 * observação boa zera a sequência na hora; com alerta ativo, só depois de
 * `minOkStreak` boas seguidas (e uma ruim no meio zera a contagem de boas).
 */
export function decidePlatformCondition(input: {
  failing: boolean;
  previousStreak: number;
  previousOkStreak?: number;
  activeSince: number | undefined;
  minStreak: number;
  minOkStreak?: number;
}): { streak: number; okStreak: number; action: "none" | "pending" | "alert" | "recovering" | "recover" } {
  if (!input.failing) {
    if (input.activeSince === undefined) {
      return { streak: 0, okStreak: 0, action: input.previousStreak > 0 ? "recover" : "none" };
    }
    const okStreak = (input.previousOkStreak ?? 0) + 1;
    return okStreak >= Math.max(1, input.minOkStreak ?? DEFAULT_MIN_OK_STREAK)
      ? { streak: 0, okStreak: 0, action: "recover" }
      : { streak: input.previousStreak, okStreak, action: "recovering" };
  }
  const streak = input.previousStreak + 1;
  return { streak, okStreak: 0, action: streak >= Math.max(1, input.minStreak) ? "alert" : "pending" };
}

export function buildPlatformRecoveryEmail(
  input: { kind: string; title: string; recoveredDetail?: string },
  extra: { deployment: string; activeSince: number; now: number }
): { subject: string; html: string } {
  const e = escapeHtml;
  return {
    subject: `[HNBCRM] Resolvido: ${input.title}`.slice(0, 160),
    html:
      `<p><strong>${e(input.recoveredDetail ?? "O problema não aparece mais nas últimas verificações.")}</strong></p>` +
      `<p>Duração aproximada: ${e(formatElapsed(extra.now - extra.activeSince))}.</p>` +
      `<p style="color:#666">Deployment: ${e(extra.deployment)}. Tipo: ${e(input.kind)}.</p>`,
  };
}

/**
 * Condição observada periodicamente (sonda, varredura): conta falhas seguidas,
 * alerta pela porta `platformAlert` (o mesmo dedupe por kind vira o lembrete
 * enquanto o problema dura) e, quando a condição some por `minOkStreak`
 * observações seguidas depois de um alerta enviado, manda UM e-mail de
 * "resolvido" e zera o carimbo (a próxima ocorrência avisa na hora).
 * Observação boa sem estado anterior não escreve nada (zero I/O no normal).
 */
export async function platformCondition(
  ctx: MutationCtx,
  input: PlatformConditionInput
): Promise<PlatformConditionResult> {
  const now = Date.now();
  const kind = input.kind.slice(0, 80);
  const row = await ctx.db
    .query("platformAlerts")
    .withIndex("by_kind", (q) => q.eq("kind", kind))
    .unique();
  const decision = decidePlatformCondition({
    failing: input.failing,
    previousStreak: row?.failStreak ?? 0,
    previousOkStreak: row?.okStreak ?? 0,
    activeSince: row?.activeSince,
    minStreak: input.minStreak ?? 1,
    minOkStreak: input.minOkStreak,
  });

  if (decision.action === "none") return { state: "ok" };
  if (!row && (decision.action === "recover" || decision.action === "recovering")) return { state: "ok" };

  if (row && decision.action === "recovering") {
    await ctx.db.patch(row._id, { okStreak: decision.okStreak, lastObservedAt: now, updatedAt: now });
    return { state: "recovering", okStreak: decision.okStreak };
  }

  if (row && decision.action === "recover") {
    const alerted = row.activeSince !== undefined && row.lastSentAt !== undefined && row.lastSentAt >= row.activeSince;
    await ctx.db.patch(row._id, {
      failStreak: 0,
      okStreak: 0,
      activeSince: undefined,
      lastSentAt: undefined,
      suppressedCount: 0,
      lastObservedAt: now,
      updatedAt: now,
    });
    const recipient = process.env.PLATFORM_ALERT_EMAIL?.trim();
    if (!alerted || !recipient) return { state: "recovered", notified: false };
    const { subject, html } = buildPlatformRecoveryEmail(
      { kind, title: input.title, recoveredDetail: input.recoveredDetail },
      { deployment: deploymentLabel(), activeSince: row.activeSince!, now }
    );
    const ok = await sendTransactionalEmail(ctx, { to: recipient, subject, html, kind: `platform_alert:${kind}:resolved` });
    return { state: "recovered", notified: ok };
  }

  // Falhando: grava a sequência (e o início do problema ao cruzar o limiar).
  const activeSince = row?.activeSince ?? (decision.action === "alert" ? now : undefined);
  const patch = {
    failStreak: decision.streak,
    okStreak: 0,
    lastObservedAt: now,
    updatedAt: now,
    ...(activeSince !== undefined ? { activeSince } : {}),
  };
  if (row) await ctx.db.patch(row._id, patch);
  else await ctx.db.insert("platformAlerts", { kind, suppressedCount: 0, ...patch });

  if (decision.action === "pending") return { state: "pending", streak: decision.streak };
  const { failing: _f, minStreak: _m, minOkStreak: _o, recoveredDetail: _r, ...alertInput } = input;
  return { state: "alerting", alert: await platformAlert(ctx, { ...alertInput, kind, activeSince }) };
}
