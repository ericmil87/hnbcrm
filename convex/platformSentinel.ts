/**
 * Sentinela de PLATAFORMA: avisa o dono do HNBCRM por e-mail (env
 * `PLATFORM_ALERT_EMAIL`, porta `lib/platformAlert.ts`) quando uma dependência
 * externa ou uma fila crítica falha. Nada aqui muda dado de cliente: só lê e
 * grava `platformAlerts` (estado/dedupe). Nos e-mails, no máximo nome de org e
 * contagens; nunca chave, telefone, e-mail ou texto de mensagem.
 *
 * - `internalProbeTick` (cron 15 min, action): sondas HTTP — OpenRouter
 *   `/key` (+ `/credits` com chave de gestão), Whisper `/health`,
 *   LibreTranslate `/languages`, Asaas (1×/hora).
 * - `internalScanTick` (cron 30 min, mutation): saída presa, transcrição presa,
 *   rajada de erros de IA, webhook do Asaas falhando, canais bridge caídos.
 * - `internalRecordBridgeProbeRound`: chamado pelo cron "channel health" com o
 *   placar da rodada (gateway do bridge fora do ar).
 * - `internalNoteLlmFailure`: falha REAL (401/402/403) da OpenRouter com a
 *   chave da plataforma (gancho em `lib/platformLlmFailure.ts`).
 * - Teste de entrega: `opsTranscription:internalPlatformAlertTest` (mesma porta).
 *
 * Desligada quando `CRONS_DISABLED=1` (DEV), sem `PLATFORM_ALERT_EMAIL` ou com
 * `RESEND_TEST_MODE=true` (o e-mail não sairia).
 */
import { v } from "convex/values";
import { internalAction, internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { cronsDisabled } from "./lib/cronGuard";
import { platformAlert, platformCondition } from "./lib/platformAlert";
import { AsaasError, getAccountName, isAsaasEnabled } from "./lib/asaasApi";
import { configTransport } from "./lib/channelTransport";
import {
  DEFAULT_LLM_ERROR_BURST,
  DEFAULT_OPENROUTER_LOW_BALANCE_USD,
  DEFAULT_STUCK_OUTBOUND_MIN,
  PROBE_TIMEOUT_MS,
  bridgeProbeRoundFailing,
  envNumber,
  evaluateOpenRouterCredits,
  evaluateOpenRouterKey,
  formatUsd,
  isStuckOutbound,
  isStuckTranscription,
  STUCK_OUTBOUND_AFTER_MS,
  summarizeNames,
} from "./lib/platformSentinel";

const HOUR = 3_600_000;
/** Lembrete de avisos (não críticos) no máximo 2× por dia. */
const WARNING_THROTTLE_MS = 12 * HOUR;
/** Mensagens recentes lidas por varredura (I/O: ~300 docs a cada 30 min). */
const SCAN_MESSAGES = 300;
/** Evento do Asaas `pending` há mais que isso: o processamento parou. */
const ASAAS_PENDING_STUCK_MS = 2 * HOUR;
/** Canal bridge caído há mais que isso sai do resumo (abandonado). */
const LOST_CHANNEL_MAX_AGE_MS = 7 * 24 * HOUR;

/** Sentinela ligada neste deployment? */
export function platformAlertsEnabled(): boolean {
  if (!process.env.PLATFORM_ALERT_EMAIL?.trim()) return false;
  return process.env.RESEND_TEST_MODE !== "true";
}

// ── Falha real de IA (gancho) ───────────────────────────────────────────────

export const internalNoteLlmFailure = internalMutation({
  args: { status: v.union(v.literal(401), v.literal(402)) },
  returns: v.null(),
  handler: async (ctx, args) => {
    // A sonda periódica já está alertando o mesmo incidente (com "resolvido"):
    // não manda um 2º crítico pelo gancho.
    const probeKind = args.status === 402 ? "openrouter_no_balance" : "openrouter_key_invalid";
    const probeRow = await ctx.db
      .query("platformAlerts")
      .withIndex("by_kind", (q) => q.eq("kind", probeKind))
      .unique();
    if (probeRow?.activeSince !== undefined) return null;
    if (args.status === 402) {
      await platformAlert(ctx, {
        kind: "openrouter_no_credit",
        severity: "critical",
        title: "OpenRouter sem crédito: a IA da plataforma está falhando",
        detail:
          "Uma chamada real de IA (atendente, copiloto, tradução, grupos ou onboarding) com a chave da plataforma recebeu HTTP 402 da OpenRouter (crédito insuficiente).",
        howToFix:
          "Recarregue o crédito em openrouter.ai/settings/credits (e confira o limite da chave em openrouter.ai/settings/keys).",
        fallback:
          "Enquanto isso o atendente IA falha e cria repasses para humanos; orgs com chave própria (BYO) não são afetadas.",
      });
    } else {
      await platformAlert(ctx, {
        kind: "openrouter_auth",
        severity: "critical",
        title: "OpenRouter recusou a chave da plataforma",
        detail: "Uma chamada real de IA com a chave da plataforma recebeu HTTP 401 da OpenRouter (chave inválida ou revogada).",
        howToFix:
          "Gere uma chave nova em openrouter.ai/settings/keys e rode: npx convex env set --prod OPENROUTER_API_KEY <chave>.",
        fallback: "Enquanto isso o atendente IA falha e cria repasses para humanos; orgs BYO não são afetadas.",
      });
    }
    return null;
  },
});

// ── Sondas externas (cron 15 min) ───────────────────────────────────────────

const verdictValidator = v.union(v.literal("ok"), v.literal("invalid"), v.literal("unknown"));

async function probe(
  url: string,
  init?: RequestInit
): Promise<{ status: number; body: unknown } | { status: 0; body: null }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

export const internalProbeTick = internalAction({
  args: {},
  returns: v.object({ skipped: v.boolean() }),
  handler: async (ctx) => {
    if (cronsDisabled() || !platformAlertsEnabled()) return { skipped: true };
    const obs: {
      openrouterKey?: "ok" | "invalid" | "unknown";
      openrouterKeyRemainingUsd?: number | null;
      openrouterKeyStatus?: number;
      credits?: "ok" | "invalid" | "unknown";
      creditsBalanceUsd?: number;
      whisperOk?: boolean;
      libreOk?: boolean;
      asaas?: "ok" | "invalid" | "unknown";
    } = {};

    const orKey = process.env.OPENROUTER_API_KEY?.trim();
    if (orKey) {
      const r = await probe("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${orKey}` } });
      const verdict = evaluateOpenRouterKey(r.status, r.body);
      obs.openrouterKey = verdict.kind;
      if (verdict.kind === "ok") obs.openrouterKeyRemainingUsd = verdict.remainingUsd;
      if (verdict.kind === "invalid") obs.openrouterKeyStatus = verdict.status;
    }
    const mgmtKey = process.env.OPENROUTER_MANAGEMENT_KEY?.trim();
    if (mgmtKey) {
      const r = await probe("https://openrouter.ai/api/v1/credits", { headers: { Authorization: `Bearer ${mgmtKey}` } });
      const verdict = evaluateOpenRouterCredits(r.status, r.body);
      obs.credits = verdict.kind;
      if (verdict.kind === "ok") obs.creditsBalanceUsd = verdict.balanceUsd;
    }
    const whisperUrl = process.env.WHISPER_SERVICE_URL?.trim();
    if (whisperUrl) {
      const r = await probe(`${whisperUrl.replace(/\/$/, "")}/health`);
      // Só rede/timeout/5xx contam como "fora" (404/401 seria config, não queda).
      obs.whisperOk = !(r.status === 0 || r.status >= 500);
    }
    const libreUrl = process.env.LIBRETRANSLATE_URL?.trim();
    if (libreUrl) {
      const r = await probe(`${libreUrl.replace(/\/$/, "")}/languages`);
      obs.libreOk = !(r.status === 0 || r.status >= 500);
    }
    // Asaas: 1×/hora (1ª rodada da hora) — a chave raramente muda.
    if (isAsaasEnabled() && new Date().getUTCMinutes() < 15) {
      try {
        await getAccountName();
        obs.asaas = "ok";
      } catch (e) {
        obs.asaas = e instanceof AsaasError && (e.status === 401 || e.status === 403) ? "invalid" : "unknown";
      }
    }
    await ctx.runMutation(internal.platformSentinel.internalApplyProbes, obs);
    return { skipped: false };
  },
});

export const internalApplyProbes = internalMutation({
  args: {
    openrouterKey: v.optional(verdictValidator),
    openrouterKeyRemainingUsd: v.optional(v.union(v.number(), v.null())),
    openrouterKeyStatus: v.optional(v.number()),
    credits: v.optional(verdictValidator),
    creditsBalanceUsd: v.optional(v.number()),
    whisperOk: v.optional(v.boolean()),
    libreOk: v.optional(v.boolean()),
    asaas: v.optional(verdictValidator),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    if (a.openrouterKey && a.openrouterKey !== "unknown") {
      await platformCondition(ctx, {
        kind: "openrouter_key_invalid",
        severity: "critical",
        failing: a.openrouterKey === "invalid",
        title: "OpenRouter recusou a chave da plataforma",
        detail: `A verificação periódica (GET /api/v1/key) recebeu HTTP ${a.openrouterKeyStatus ?? "401"}: a chave OPENROUTER_API_KEY não é aceita.`,
        howToFix:
          "Gere uma chave nova em openrouter.ai/settings/keys e rode: npx convex env set --prod OPENROUTER_API_KEY <chave>.",
        fallback: "O atendente, o copiloto, a visão e a tradução por IA da plataforma param; orgs BYO seguem.",
        recoveredDetail: "A chave da OpenRouter voltou a ser aceita.",
      });
    }

    // Saldo: o menor entre o restante da chave e o saldo da conta (se medido).
    const balances: { value: number; label: string }[] = [];
    if (a.openrouterKey === "ok" && typeof a.openrouterKeyRemainingUsd === "number") {
      balances.push({ value: a.openrouterKeyRemainingUsd, label: "limite restante da chave" });
    }
    if (a.credits === "ok" && typeof a.creditsBalanceUsd === "number") {
      balances.push({ value: a.creditsBalanceUsd, label: "saldo da conta" });
    }
    if (balances.length > 0) {
      const threshold = envNumber(process.env.OPENROUTER_LOW_BALANCE_USD, DEFAULT_OPENROUTER_LOW_BALANCE_USD, { max: 100_000 });
      const lowest = balances.reduce((m, b) => (b.value < m.value ? b : m));
      const howToFix = "Recarregue em openrouter.ai/settings/credits ou aumente o limite da chave em openrouter.ai/settings/keys.";
      // Dois kinds: o aviso de saldo baixo (12 h) não pode segurar o crítico de saldo zerado.
      await platformCondition(ctx, {
        kind: "openrouter_low_balance",
        severity: "warning",
        failing: lowest.value < threshold,
        title: "OpenRouter com saldo baixo",
        detail: `OpenRouter: ${lowest.label} = ${formatUsd(lowest.value)} (aviso abaixo de ${formatUsd(threshold)}).`,
        howToFix,
        throttleMs: WARNING_THROTTLE_MS,
        recoveredDetail: `O saldo da OpenRouter voltou a ficar acima de ${formatUsd(threshold)}.`,
      });
      await platformCondition(ctx, {
        kind: "openrouter_no_balance",
        severity: "critical",
        failing: lowest.value <= 0,
        title: "OpenRouter sem saldo: a IA da plataforma vai parar",
        detail: `OpenRouter: ${lowest.label} = ${formatUsd(lowest.value)}. Chamadas com a chave da plataforma recebem HTTP 402.`,
        howToFix,
        fallback: "O atendente IA falha e cria repasses para humanos; orgs com chave própria (BYO) não são afetadas.",
        recoveredDetail: "A OpenRouter voltou a ter saldo.",
      });
    }
    if (a.credits && a.credits !== "unknown") {
      await platformCondition(ctx, {
        kind: "openrouter_management_key_invalid",
        severity: "warning",
        failing: a.credits === "invalid",
        title: "Chave de gestão da OpenRouter recusada",
        detail: "GET /api/v1/credits recusou OPENROUTER_MANAGEMENT_KEY: o saldo da conta não está sendo vigiado.",
        howToFix: "Crie uma chave de gestão (Management key) em openrouter.ai/settings/management-keys e atualize a env.",
        throttleMs: WARNING_THROTTLE_MS,
      });
    }
    if (a.whisperOk !== undefined) {
      await platformCondition(ctx, {
        kind: "whisper_down",
        severity: "critical",
        failing: !a.whisperOk,
        minStreak: 2,
        title: "Whisper da VPS fora do ar: notas de voz sem transcrição",
        detail: "O serviço Whisper (WHISPER_SERVICE_URL /health) não respondeu em duas verificações seguidas (15 min de intervalo).",
        howToFix: "Na VPS: docker ps / docker logs do container whisper; reinicie o serviço e confira rede e disco.",
        fallback: "Áudios longos ainda vão para a Groq (se configurada); os curtos ficam sem transcrição e o atendente responde sem entender o áudio.",
        recoveredDetail: "O Whisper da VPS voltou a responder.",
      });
    }
    if (a.libreOk !== undefined) {
      await platformCondition(ctx, {
        kind: "libretranslate_down",
        severity: "warning",
        failing: !a.libreOk,
        minStreak: 2,
        title: "LibreTranslate fora do ar",
        detail: "O LibreTranslate (LIBRETRANSLATE_URL /languages) não respondeu em duas verificações seguidas.",
        howToFix: "Na VPS: confira o container do LibreTranslate e o proxy/certificado de lt.hnbcrm.com.",
        fallback: "A tradução automática cai para a IA (mais cara) nas orgs com IA ligada; nas outras, fica sem tradução.",
        throttleMs: WARNING_THROTTLE_MS,
        recoveredDetail: "O LibreTranslate voltou a responder.",
      });
    }
    if (a.asaas && a.asaas !== "unknown") {
      await platformCondition(ctx, {
        kind: "asaas_key_invalid",
        severity: "critical",
        failing: a.asaas === "invalid",
        title: "Asaas recusou a chave da API: cobrança automática parada",
        detail: "A verificação horária da chave da API do Asaas recebeu 401/403.",
        howToFix: "Gere uma chave nova no painel do Asaas (Integrações) e atualize a env da chave do Asaas no PROD (npx convex env set --prod).",
        fallback: "Assinaturas, upgrades e webhooks de pagamento não são processados até a chave voltar.",
        recoveredDetail: "A chave do Asaas voltou a ser aceita.",
      });
    }
    return null;
  },
});

// ── Gateway do bridge (placar do cron "channel health") ─────────────────────

export const internalRecordBridgeProbeRound = internalMutation({
  args: { checked: v.number(), probeErrors: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!platformAlertsEnabled()) return null;
    await platformCondition(ctx, {
      kind: "bridge_gateway_unreachable",
      severity: "critical",
      failing: bridgeProbeRoundFailing(args.checked, args.probeErrors),
      minStreak: 2,
      title: "Gateway do WhatsApp (bridge) inalcançável",
      detail: `Na última rodada completa do monitor de canais, ${args.probeErrors} de ${args.checked + args.probeErrors} sondas ao gateway falharam por rede, timeout ou erro 5xx, pela 2ª rodada seguida.`,
      howToFix: "Confira a VPS do wuzapi (container, rede, certificado do domínio do gateway) e os logs do Convex do cron \"channel health\".",
      fallback: "Mensagens de WhatsApp via bridge não entram nem saem enquanto isso; os clientes não são avisados automaticamente.",
      recoveredDetail: "As sondas ao gateway do bridge voltaram a responder.",
    });
    return null;
  },
});

// ── Varreduras do banco (cron 30 min) ───────────────────────────────────────

async function orgName(
  ctx: MutationCtx,
  cache: Map<Id<"organizations">, Doc<"organizations"> | null>,
  id: Id<"organizations">
): Promise<{ name: string; demo: boolean; byo: boolean }> {
  let org = cache.get(id);
  if (org === undefined) {
    org = await ctx.db.get(id);
    cache.set(id, org);
  }
  const settings = org?.settings as
    | { demoMode?: boolean; aiConfig?: { providerConfig?: { mode?: string } } }
    | undefined;
  return {
    name: org?.name ?? "org removida",
    demo: settings?.demoMode === true,
    byo: settings?.aiConfig?.providerConfig?.mode === "byo",
  };
}

export const internalScanTick = internalMutation({
  args: {},
  returns: v.object({
    skipped: v.boolean(),
    stuckOutbound: v.number(),
    stuckTranscriptions: v.number(),
    llmErrors: v.number(),
    asaasProblems: v.number(),
    bridgeChannelsLost: v.number(),
  }),
  handler: async (ctx) => {
    const zero = { stuckOutbound: 0, stuckTranscriptions: 0, llmErrors: 0, asaasProblems: 0, bridgeChannelsLost: 0 };
    if (cronsDisabled() || !platformAlertsEnabled()) return { skipped: true, ...zero };
    const now = Date.now();
    const orgs = new Map<Id<"organizations">, Doc<"organizations"> | null>();

    // 1) Mensagens recentes: saída presa e transcrição presa.
    // Começa já fora da janela de graça: num pico, as 300 mais novas cobririam
    // menos de 15 min e um incidente em curso pareceria resolvido.
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", now - STUCK_OUTBOUND_AFTER_MS))
      .order("desc")
      .take(SCAN_MESSAGES);
    const stuckOrgs: string[] = [];
    let stuckOutbound = 0;
    let stuckTranscriptions = 0;
    for (const m of recent) {
      if (isStuckTranscription(m, now)) stuckTranscriptions++;
      if (!isStuckOutbound(m, now)) continue;
      const conversation = await ctx.db.get(m.conversationId);
      if (!conversation || !["whatsapp", "instagram", "messenger"].includes(conversation.channel)) continue;
      const org = await orgName(ctx, orgs, conversation.organizationId);
      if (org.demo) continue;
      stuckOutbound++;
      stuckOrgs.push(org.name);
    }
    const stuckMin = envNumber(process.env.PLATFORM_ALERT_STUCK_OUTBOUND_MIN, DEFAULT_STUCK_OUTBOUND_MIN, { min: 1, max: 1000 });
    await platformCondition(ctx, {
      kind: "outbound_stuck",
      severity: "critical",
      failing: stuckOutbound >= stuckMin,
      title: "Mensagens de saída presas (não enviadas)",
      detail: `${stuckOutbound} mensagem(ns) de saída sem envio há mais de 15 min (últimas 6 h). Orgs: ${summarizeNames(stuckOrgs) || "-"}.`,
      howToFix:
        "Veja os logs do Convex (whatsapp:internalDispatchMessage) e o estado do canal. Para reenviar: npx convex run --prod opsMigration:internalRedispatchStuckOutbound '{\"sinceMs\":21600000}' (dryRun primeiro).",
      recoveredDetail: "Não aparecem mais mensagens de saída presas nas últimas 6 h (enviadas, falhadas de forma visível ou fora da janela).",
    });
    await platformCondition(ctx, {
      kind: "transcription_stuck",
      severity: "warning",
      failing: stuckTranscriptions >= 2,
      title: "Fila de transcrição de áudio parada",
      detail: `${stuckTranscriptions} nota(s) de voz com transcrição pendente há mais de 20 min.`,
      howToFix: "Confira o Whisper da VPS e os logs de transcription:autoTranscribe no Convex.",
      throttleMs: WARNING_THROTTLE_MS,
      recoveredDetail: "Não aparecem mais transcrições pendentes antigas nas últimas 6 h.",
    });

    // 2) Rajada de erros de IA na última hora (qualquer causa).
    const burst = envNumber(process.env.PLATFORM_ALERT_LLM_ERROR_BURST, DEFAULT_LLM_ERROR_BURST, { min: 1, max: 1000 });
    const errors = await ctx.db
      .query("agentRuns")
      .withIndex("by_status_and_started", (q) => q.eq("status", "error").gte("startedAt", now - HOUR))
      // Amostra larga: as runs de orgs BYO são descartadas DEPOIS da leitura.
      .take(Math.min(500, burst * 10));
    const byKind = new Map<string, number>();
    const errorOrgs = new Set<string>();
    let platformErrors = 0;
    for (const r of errors) {
      // Org com chave própria (BYO) paga e resolve a própria conta: fora da contagem.
      if ((await orgName(ctx, orgs, r.organizationId)).byo) continue;
      // O juiz de afirmação (timeout, JSON inválido) falha de propósito sem travar a conversa: não é falha de IA do produto.
      if (r.kind === "sched_claim_judge") continue;
      platformErrors++;
      byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
      errorOrgs.add(r.organizationId);
    }
    const kinds = [...byKind.entries()].map(([k, n]) => `${k} ${n}`).join(", ");
    await platformCondition(ctx, {
      kind: "llm_error_burst",
      severity: "warning",
      failing: platformErrors >= burst,
      title: "Muitas falhas de IA na última hora",
      detail: `${platformErrors}${errors.length >= Math.min(500, burst * 10) ? "+" : ""} execuções de IA com erro na última hora (${kinds || "-"}), em ${errorOrgs.size} org(s) sem chave própria.`,
      howToFix:
        "Rode npx convex run --prod aiDiagnostics:pingChain para ver o erro de cada rota (429 sustentado, provedor fora, modelo removido).",
      throttleMs: WARNING_THROTTLE_MS,
      recoveredDetail: "As falhas de IA voltaram ao normal.",
    });

    // 3) Asaas: evento falhado nas últimas 24 h ou pendente há mais de 2 h.
    const failed = await ctx.db
      .query("billingWebhookEvents")
      .withIndex("by_status_and_received_at", (q) => q.eq("status", "failed").gte("receivedAt", now - 24 * HOUR))
      .take(20);
    const pending = await ctx.db
      .query("billingWebhookEvents")
      .withIndex("by_status_and_received_at", (q) => q.eq("status", "pending").lt("receivedAt", now - ASAAS_PENDING_STUCK_MS))
      .take(20);
    const asaasProblems = failed.length + pending.length;
    await platformCondition(ctx, {
      kind: "asaas_webhook_failing",
      severity: "critical",
      failing: asaasProblems > 0,
      title: "Webhooks do Asaas falhando: pagamentos não processados",
      detail: `${failed.length} evento(s) do Asaas falharam nas últimas 24 h e ${pending.length} estão pendentes há mais de 2 h.`,
      howToFix:
        "Veja billingWebhookEvents (status failed, campo error) e os logs de billingAsaas no Convex; depois do conserto, reprocesse pelas ops de billing.",
      fallback: "Planos pagos podem não ser liberados nem renovados até o reprocessamento.",
      recoveredDetail: "Não há mais eventos do Asaas falhados ou presos.",
    });

    // 4) Canais bridge armados que caíram (admins da org já foram avisados).
    const configs = await ctx.db.query("channelConfigs").take(500);
    const lostOrgs: string[] = [];
    for (const c of configs) {
      if (c.status !== "active" || c.bridgeSessionAlertedAt === undefined) continue;
      // Canal largado há mais de 7 dias: o cliente já sabe; não repetir para sempre.
      if (now - c.bridgeSessionAlertedAt > LOST_CHANNEL_MAX_AGE_MS) continue;
      if (c.bridgeSessionState === "connected") continue;
      try {
        if (configTransport(c) !== "bridge") continue;
      } catch {
        continue;
      }
      const org = await orgName(ctx, orgs, c.organizationId);
      if (org.demo) continue;
      lostOrgs.push(org.name);
    }
    await platformCondition(ctx, {
      kind: "bridge_channels_lost",
      severity: "warning",
      failing: lostOrgs.length > 0,
      title: "Canais de WhatsApp (bridge) desconectados",
      detail: `${lostOrgs.length} canal(is) ativos sem sessão (caídos nos últimos 7 dias): ${summarizeNames(lostOrgs)}. Os admins dessas orgs já foram avisados pelo app.`,
      howToFix: "Combine com o cliente a reconexão (QR ou código em Configurações > Canais, ou pelo Telegram).",
      throttleMs: 24 * HOUR,
      recoveredDetail: "Todos os canais bridge ativos voltaram a ter sessão.",
    });

    return {
      skipped: false,
      stuckOutbound,
      stuckTranscriptions,
      llmErrors: platformErrors,
      asaasProblems,
      bridgeChannelsLost: lostOrgs.length,
    };
  },
});
