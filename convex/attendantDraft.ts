/**
 * Gerador de rascunho do Atendente IA ("Escrever com IA", fv2-18).
 *
 * Lê o perfil do negócio e o segmento gravados NO SERVIDOR, pede ao modelo um
 * rascunho e devolve — sem persistir nada (salvar é `updateAgentProfile`).
 * Gates, todos ANTES do modelo: `settings:manage` + conta com e-mail,
 * `orgAiActive` e teto de gastos. Falha do modelo nunca lança: devolve o
 * rascunho do template com `warnings`. Custo em `agentRuns` (`attendant_draft`).
 */
import { v } from "convex/values";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { spendStatusFor } from "./aiSpend";
import { requireAccountWithEmail, requirePermission } from "./lib/auth";
import { orgAiActive } from "./lib/agentSecurity";
import { isValidMonthKey, monthKeyUtc, SPEND_CAP_BLOCKED_MESSAGE } from "./lib/aiSpend";
import { addUsage, finishRunCostFields, newUsageTotals } from "./lib/aiSpend";
import { resolveOrgRoutes, type OrgProviderConfig } from "./lib/agentRoutes";
import { DEFAULT_MODELS } from "./lib/llm/registry";
import { chatWithFallback } from "./lib/llm";
import { sanitizeLlmError } from "./lib/llm/sanitize";
import { segmentTemplate, renderPersonaSeed } from "./lib/onboardingTemplates";
import {
  buildAttendantDraftPrompt,
  mergeGreetingIntoPersona,
  parseAttendantDraft,
  templateFallbackDraft,
  TONE_LABEL,
  type DraftBusiness,
} from "./lib/attendantDraft";

// 45 s é POR TENTATIVA: chatWithFallback tenta até 2 vezes por rota (e passa à próxima rota).
const DRAFT_TIMEOUT_MS = 45_000;
const DRAFT_TEMPERATURE = 0.4;
const DRAFT_MAX_TOKENS = 6_000;

const businessValidator = v.object({
  displayName: v.optional(v.string()),
  offer: v.optional(v.string()),
  audience: v.optional(v.string()),
  tone: v.optional(
    v.union(v.literal("formal"), v.literal("amigavel"), v.literal("descontraido")),
  ),
  region: v.optional(v.string()),
});

const draftValidator = v.object({
  name: v.string(),
  persona: v.string(),
  greeting: v.string(),
  knowledge: v.string(),
  handoffKeywords: v.array(v.string()),
  warnings: v.array(v.string()),
});

export const internalGetDraftSetup = internalQuery({
  args: { organizationId: v.id("organizations"), month: v.string() },
  returns: v.object({
    memberId: v.id("teamMembers"),
    segment: v.string(),
    business: businessValidator,
    providerConfig: v.any(),
  }),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    await requireAccountWithEmail(ctx);
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new Error("Organização não encontrada");
    if (!orgAiActive(org)) throw new Error("Ative a IA primeiro");
    if (!isValidMonthKey(args.month)) throw new Error("Mês inválido (use AAAA-MM)");
    const gate = await spendStatusFor(ctx, org, args.month);
    if (gate.blocked) throw new Error(SPEND_CAP_BLOCKED_MESSAGE);
    return {
      memberId: member._id,
      segment: org.onboardingMeta?.industry ?? "outro",
      business: org.onboardingMeta?.business ?? {},
      providerConfig: org.settings.aiConfig?.providerConfig ?? null,
    };
  },
});

export const generateAttendantDraft = action({
  args: { organizationId: v.id("organizations") },
  returns: draftValidator,
  handler: async (ctx, args) => {
    const setup = await ctx.runQuery(internal.attendantDraft.internalGetDraftSetup, {
      organizationId: args.organizationId,
      month: monthKeyUtc(Date.now()),
    });
    const template = segmentTemplate(setup.segment);
    const business: DraftBusiness = setup.business;
    const providerConfig = setup.providerConfig as OrgProviderConfig | null;
    const finish = (draft: ReturnType<typeof templateFallbackDraft>) => ({
      ...draft,
      persona: mergeGreetingIntoPersona(draft.persona, draft.greeting),
    });

    const model =
      (providerConfig?.models as { attendant?: string } | undefined)?.attendant ??
      DEFAULT_MODELS.attendant;
    let routes;
    try {
      routes = await resolveOrgRoutes(ctx, args.organizationId, providerConfig, model, "attendant");
    } catch (e) {
      return finish(
        templateFallbackDraft(
          template,
          business,
          `Não foi possível usar a IA agora (${sanitizeLlmError(e instanceof Error ? e.message : "erro")}); usamos o modelo do segmento.`,
        ),
      );
    }
    if (routes.length === 0) {
      return finish(
        templateFallbackDraft(
          template,
          business,
          "Nenhum provedor de IA disponível; usamos o modelo do segmento.",
        ),
      );
    }

    const runId = await ctx.runMutation(internal.agentRuns.internalStartRun, {
      organizationId: args.organizationId,
      memberId: setup.memberId,
      kind: "attendant_draft",
      model,
    });
    const usage = newUsageTotals();
    try {
      const prompt = buildAttendantDraftPrompt({
        segmentLabel: template.label,
        business,
        personaSeed: renderPersonaSeed(template, {
          negocio: business.displayName,
          oferta: business.offer,
          tom: business.tone ? TONE_LABEL[business.tone] : undefined,
        }),
        faqSeed: template.faqSeed,
        handoffSeed: template.handoffKeywords,
      });
      const resp = await chatWithFallback(
        routes,
        {
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          temperature: DRAFT_TEMPERATURE,
          maxTokens: DRAFT_MAX_TOKENS,
          responseFormat: { type: "json_object" },
        },
        { timeoutMs: DRAFT_TIMEOUT_MS },
      );
      addUsage(usage, resp.usage, resp.usedRoute, model);
      const draft = parseAttendantDraft(resp.message.content ?? "", template, business);
      if (resp.finishReason === "length") {
        draft.warnings.push("A resposta da IA foi cortada; revise o texto.");
      }
      await ctx.runMutation(internal.agentRuns.internalFinishRun, {
        runId,
        status: "done",
        provider: resp.usedRoute.providerId,
        model,
        requestCount: 1,
        ...finishRunCostFields(usage),
      });
      return finish(draft);
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "AbortError" || /timed out/i.test(e.message));
      const message = timedOut
        ? "A IA não respondeu a tempo"
        : `A IA falhou: ${sanitizeLlmError(e instanceof Error ? e.message : "Erro inesperado")}`;
      try {
        await ctx.runMutation(internal.agentRuns.internalFinishRun, {
          runId,
          status: "error",
          requestCount: 1,
          ...finishRunCostFields(usage),
          error: message,
        });
      } catch {
        // Registrar a run não pode impedir o rascunho do template.
      }
      return finish(
        templateFallbackDraft(
          template,
          business,
          `${message}; usamos o modelo do segmento. Você pode tentar de novo.`,
        ),
      );
    }
  },
});
