/**
 * Resolve as rotas LLM de uma org para o runtime (copiloto/atendente/simulador).
 *
 * - platform (default): cadeia OpenCode Go → OpenRouter (inativo sem a key), mais a
 *   rede de modelo `MODEL_FALLBACKS` (o padrão só-OpenRouter cai no deepseek-v4-flash).
 * - byo: a key da org (orgSecrets, cifrada) — decrypt SÓ aqui, em contexto de
 *   action; SEM fallback para as keys da plataforma (a org paga a própria conta).
 * - strictZdr filtra rotas não-ZDR nos dois modos (o "aviso vira bloqueio").
 */
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { decryptSecret } from "./secretCrypto";
import { resolvePlatformChain, resolveByoRoute, ResolvedRoute } from "./llm";
import {
  BYO_NON_OPENROUTER_MODEL,
  DEFAULT_MODELS,
  MODEL_FALLBACKS,
  resolveRetiredModel,
} from "./llm/registry";

export type PlatformOrder = "auto" | "openrouter-first" | "opencode-only" | "openrouter-only";

/** Produtos de IA que escolhem a própria rota (Configurações → IA). */
export type AiProduct =
  | "copilot"
  | "attendant"
  | "vision"
  | "groupPosts"
  /** Agente que responde DENTRO de um grupo de WhatsApp (F4). */
  | "groupAgent"
  /** Copiloto no Telegram (D16): rota e modelo próprios. */
  | "telegramCopilot"
  /** Tradução automática (F1): rota e modelo próprios, modelo barato fixo. */
  | "translation";

/** Produtos que escolhem o PRÓPRIO modelo de texto (padrão só no OpenRouter). */
export type ModelPinnedProduct = "telegramCopilot" | "translation";

export interface ProductRouting {
  order?: PlatformOrder;
  /** Visão e Copiloto no Telegram: ausente = o padrão do produto. */
  model?: string;
}

export interface OrgProviderConfig {
  mode?: "platform" | "byo";
  byo?: {
    provider: string;
    baseUrl?: string;
    apiKeyRef: { kind: "orgSecret"; id: Id<"orgSecrets"> };
  };
  strictZdr?: boolean;
  platformOrder?: PlatformOrder;
  products?: Partial<Record<AiProduct, ProductRouting>>;
  models?: { copilot?: string };
}

const PLATFORM_ORDERS: PlatformOrder[] = [
  "auto",
  "openrouter-first",
  "opencode-only",
  "openrouter-only",
];

// Override de ops no deployment (vale para orgs SEM escolha própria salva).
function envPlatformOrder(): PlatformOrder | undefined {
  const raw = process.env.LLM_PLATFORM_ORDER?.trim();
  return PLATFORM_ORDERS.includes(raw as PlatformOrder) ? (raw as PlatformOrder) : undefined;
}

// Reordena/filtra a cadeia da plataforma conforme a preferência da org.
// "auto" (default) mantém a ordem do env: OpenCode Go → OpenRouter.
export function applyPlatformOrder(
  routes: ResolvedRoute[],
  order: PlatformOrder | undefined
): ResolvedRoute[] {
  switch (order) {
    case "openrouter-first": {
      const openrouter = routes.filter((r) => r.providerId === "openrouter");
      return [...openrouter, ...routes.filter((r) => r.providerId !== "openrouter")];
    }
    case "openrouter-only":
      return routes.filter((r) => r.providerId === "openrouter");
    case "opencode-only":
      return routes.filter((r) => r.providerId === "opencode-go");
    default:
      return routes;
  }
}

type RunQueryCtx = {
  runQuery: (
    ref: typeof internal.orgSecrets.internalGetOrgSecretEncrypted,
    args: { secretId: Id<"orgSecrets">; organizationId: Id<"organizations"> }
  ) => Promise<string | null>;
};

/**
 * A resposta em áudio (P4.1, `lib/tts.ts`) só existe no OpenRouter e usa a
 * chave da PLATAFORMA. Org em BYO (decidiu pagar e escolher o próprio provedor)
 * ou com a rota do atendente em `opencode-only` (tirou o OpenRouter da cadeia)
 * não manda texto para lá: a resposta sai em texto.
 */
export function platformTtsAllowed(providerConfig: OrgProviderConfig | null | undefined): boolean {
  if (providerConfig?.mode === "byo") return false;
  return effectivePlatformOrder(providerConfig, "attendant") !== "opencode-only";
}

/**
 * Ordem efetiva da cadeia para um produto. Precedência, do mais específico ao
 * mais geral: escolha do PRODUTO > padrão da ORG > override de ops no
 * deployment (env LLM_PLATFORM_ORDER) > "auto".
 *
 * O BYO não entra aqui de propósito: chave própria é decisão da organização
 * inteira. Ela não tem fallback, e deixar um único produto sozinho numa rota
 * que caiu é uma falha que ninguém percebe até o cliente reclamar.
 */
export function effectivePlatformOrder(
  providerConfig: OrgProviderConfig | null | undefined,
  product?: AiProduct
): PlatformOrder | undefined {
  const perProduct = product ? providerConfig?.products?.[product]?.order : undefined;
  // D16: o Copiloto no Telegram nasce em "openrouter-first" (o modelo padrão
  // só existe no OpenRouter); a escolha do produto ou da org ainda vence.
  if (product === "telegramCopilot" || product === "translation") {
    return perProduct ?? providerConfig?.platformOrder ?? "openrouter-first";
  }
  return perProduct ?? providerConfig?.platformOrder ?? envPlatformOrder();
}

/**
 * Modelo canônico de um produto que escolhe o próprio modelo (D16). Copiloto
 * no Telegram: o fixado no produto; senão `DEFAULT_MODELS.telegramCopilot`
 * (`deepseek-flash-latest`, só OpenRouter) no modo plataforma; no BYO a chave
 * da org não fala esse alias, então vale o modelo do Copiloto da org.
 */
export function productModel(
  providerConfig: OrgProviderConfig | null | undefined,
  product: ModelPinnedProduct
): { model: string; fallback: string } {
  const copilot = providerConfig?.models?.copilot ?? DEFAULT_MODELS.copilot;
  const pinned = providerConfig?.products?.[product]?.model?.trim();
  if (pinned) return { model: pinned, fallback: copilot };
  if (providerConfig?.mode === "byo") return { model: copilot, fallback: copilot };
  // Tradução: o fallback é o modelo barato de classificação (funciona sem
  // OpenRouter), não o do Copiloto (caro para traduzir uma frase).
  if (product === "translation") return { model: DEFAULT_MODELS.translation, fallback: DEFAULT_MODELS.classify };
  return { model: DEFAULT_MODELS.telegramCopilot, fallback: copilot };
}

/**
 * Rotas do produto com fallback de modelo: se o modelo do produto não tem rota
 * neste deployment (ex.: `deepseek-flash-latest` sem OPENROUTER_API_KEY), cai
 * no `fallback` (o modelo do Copiloto), que funciona sem OpenRouter. Sem rota
 * nenhuma, lança com a mensagem PT-BR de sempre.
 */
export async function resolveProductRoutes(
  ctx: RunQueryCtx,
  organizationId: Id<"organizations">,
  providerConfig: OrgProviderConfig | null | undefined,
  product: ModelPinnedProduct
): Promise<{ routes: ResolvedRoute[]; canonicalModel: string }> {
  const { model, fallback } = productModel(providerConfig, product);
  // Copiloto no Telegram mantém o fallback próprio (modelo do Copiloto): só a
  // tradução herda a rede de modelo (`MODEL_FALLBACKS`), que substitui o antigo
  // fallback `classify` (agora é o mesmo alias).
  const routes = await resolveOrgRoutes(ctx, organizationId, providerConfig, model, product, {
    modelFallback: product !== "telegramCopilot",
  });
  if (routes.length > 0 || fallback === model) return { routes, canonicalModel: model };
  const fallbackRoutes = await resolveOrgRoutes(ctx, organizationId, providerConfig, fallback, product);
  return { routes: fallbackRoutes, canonicalModel: fallback };
}

export async function resolveOrgRoutes(
  ctx: RunQueryCtx,
  organizationId: Id<"organizations">,
  providerConfig: OrgProviderConfig | null | undefined,
  requestedModel: string,
  product?: AiProduct,
  opts?: { modelFallback?: boolean }
): Promise<ResolvedRoute[]> {
  let routes: ResolvedRoute[];
  // Id aposentado gravado na org (ou fixado por env) roda como o alias.
  const canonicalModel = resolveRetiredModel(requestedModel);

  if (providerConfig?.mode === "byo" && providerConfig.byo) {
    const encrypted = await ctx.runQuery(internal.orgSecrets.internalGetOrgSecretEncrypted, {
      secretId: providerConfig.byo.apiKeyRef.id,
      organizationId,
    });
    if (!encrypted) throw new Error("Chave de API BYO não encontrada — reconfigure o provider");
    const apiKey = await decryptSecret(encrypted);
    routes = [
      resolveByoRoute(
        {
          provider: providerConfig.byo.provider,
          baseUrl: providerConfig.byo.baseUrl,
          apiKey,
        },
        // Chave que não é do OpenRouter não fala o alias: usa o equivalente.
        providerConfig.byo.provider === "openrouter"
          ? canonicalModel
          : (BYO_NON_OPENROUTER_MODEL[canonicalModel] ?? canonicalModel)
      ),
    ];
  } else {
    const keys = {
      opencodeGoKey: process.env.OPENCODE_GO_API,
      openrouterKey: process.env.OPENROUTER_API_KEY,
    };
    const chain = resolvePlatformChain(canonicalModel, keys);
    // Rede de modelo: depois dos elos do modelo pedido, os do(s) fallback(s).
    // Sem OPENROUTER_API_KEY o modelo só-OpenRouter não tem elo e a cadeia cai
    // direto no fallback (OpenCode Go).
    if (opts?.modelFallback !== false) {
      for (const fb of MODEL_FALLBACKS[canonicalModel] ?? []) {
        chain.push(...resolvePlatformChain(fb, keys));
      }
    }
    routes = applyPlatformOrder(chain, effectivePlatformOrder(providerConfig, product));
  }

  if (providerConfig?.strictZdr) {
    routes = routes.filter((r) => r.zdr.zdrCapable);
  }
  return routes;
}
