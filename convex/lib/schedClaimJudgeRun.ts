/**
 * Agenda v2 (D3) — a chamada do juiz de afirmação (action). Mesma infraestrutura do classificador da confirmação pelo WhatsApp
 * (`schedulingInterpret.runClassifier`): rotas da org (`resolveOrgRoutes`, ZDR), `withoutReasoning`, teto de gasto
 * (`internalSpendGate`), run em `agentRuns` (`kind: "sched_claim_judge"`, sem transcrição), modelo `providerConfig.models.classify`,
 * saída `json_object` validada no servidor (`validateJudgeReply`).
 *
 * NUNCA lança e nunca trava a conversa: timeout (≈ 6 s), erro, JSON inválido, resposta cortada ou teto de gasto devolvem
 * `{ ok: false, reason }` e quem chama mantém o veredito do léxico (a mensagem já tinha passado por ele).
 */
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { type OrgProviderConfig, resolveOrgRoutes } from "./agentRoutes";
import { addUsage, finishRunCostFields, monthKeyUtc, newUsageTotals } from "./aiSpend";
import { chatWithFallback, withoutReasoning } from "./llm";
import { DEFAULT_MODELS } from "./llm/registry";
import { sanitizeLlmError } from "./llm/sanitize";
import { buildJudgePrompt, type JudgeVerdict, validateJudgeReply } from "./schedClaimJudge";
import { CLAIM_JUDGE_TIMEOUT_MS } from "./schedConstants";

/** Folga para o modelo que raciocina mesmo com o raciocínio desligado; a resposta normal tem ~80 tokens. */
const JUDGE_MAX_TOKENS = 400;

export type JudgeCallResult =
  | { ok: true; verdict: JudgeVerdict; promptTokens: number; completionTokens: number; costUsd: number; latencyMs: number }
  | { ok: false; reason: "spend_gate" | "no_route" | "timeout" | "error" | "invalid" | "truncated" };

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("juiz: tempo esgotado")), ms);
    p.then(
      (x) => {
        clearTimeout(timer);
        resolve(x);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });

export async function runClaimJudge(
  ctx: ActionCtx,
  args: {
    organizationId: Id<"organizations">;
    conversationId: Id<"conversations">;
    providerConfig: OrgProviderConfig | null;
    /** A resposta da PRÓPRIA IA que vai ao cliente (não a mensagem do cliente). */
    text: string;
    /** Data local de hoje (`AAAA-MM-DD`) no fuso da org. */
    today: string;
  }
): Promise<JudgeCallResult> {
  try {
    const now = Date.now();
    const gate = await ctx.runQuery(internal.aiSpend.internalSpendGate, { organizationId: args.organizationId, month: monthKeyUtc(now), now });
    if (gate.blocked) return { ok: false, reason: "spend_gate" };
    const model = (args.providerConfig as { models?: { classify?: string } } | null)?.models?.classify ?? DEFAULT_MODELS.classify;
    const routes = withoutReasoning(await resolveOrgRoutes(ctx, args.organizationId, args.providerConfig, model));
    if (routes.length === 0) return { ok: false, reason: "no_route" };
    const prompt = buildJudgePrompt(args.text, args.today);
    const runId = await ctx.runMutation(internal.agentRuns.internalStartRun, {
      organizationId: args.organizationId,
      kind: "sched_claim_judge" as const,
      conversationId: args.conversationId,
      model,
    });
    const usage = newUsageTotals();
    let provider: string | undefined;
    let usedModel: string | undefined;
    const started = Date.now();
    try {
      const res = await withTimeout(
        chatWithFallback(
          routes,
          {
            messages: [
              { role: "system", content: prompt.system },
              { role: "user", content: prompt.user },
            ],
            temperature: 0,
            maxTokens: JUDGE_MAX_TOKENS,
            responseFormat: { type: "json_object" },
          },
          { timeoutMs: CLAIM_JUDGE_TIMEOUT_MS }
        ),
        CLAIM_JUDGE_TIMEOUT_MS + 500
      );
      const latencyMs = Date.now() - started;
      addUsage(usage, res.usage, res.usedRoute, model, { inputChars: prompt.system.length + prompt.user.length, outputChars: JSON.stringify(res.message).length });
      provider = res.usedRoute.providerId;
      usedModel = res.usedRoute.canonicalModel;
      const raw = typeof res.message.content === "string" ? res.message.content : "";
      // Resposta cortada nunca é aceita (o JSON pode ter fechado sozinho no meio).
      const verdict = res.finishReason === "length" ? null : validateJudgeReply(raw);
      await ctx.runMutation(internal.agentRuns.internalFinishRun, {
        runId,
        status: verdict ? "done" : "error",
        provider,
        model: usedModel,
        requestCount: 1,
        ...finishRunCostFields(usage),
        ...(verdict ? {} : { error: "juiz: resposta que não valida" }),
      });
      if (!verdict) return { ok: false, reason: res.finishReason === "length" ? "truncated" : "invalid" };
      return { ok: true, verdict, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, costUsd: usage.costUsd, latencyMs };
    } catch (e) {
      const message = e instanceof Error ? e.message : "falha ao chamar a IA";
      await ctx.runMutation(internal.agentRuns.internalFinishRun, {
        runId,
        status: "error",
        ...(provider ? { provider } : {}),
        ...(usedModel ? { model: usedModel } : {}),
        requestCount: 1,
        ...finishRunCostFields(usage),
        error: sanitizeLlmError(message),
      });
      return { ok: false, reason: /tempo esgotado|timeout|aborted/i.test(message) ? "timeout" : "error" };
    }
  } catch {
    return { ok: false, reason: "error" };
  }
}
