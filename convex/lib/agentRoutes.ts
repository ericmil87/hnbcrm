/**
 * Resolve as rotas LLM de uma org para o runtime (copiloto/atendente/simulador).
 *
 * - platform (default): cadeia OpenCode Go → OpenRouter (inativo sem a key).
 * - byo: a key da org (orgSecrets, cifrada) — decrypt SÓ aqui, em contexto de
 *   action; SEM fallback para as keys da plataforma (a org paga a própria conta).
 * - strictZdr filtra rotas não-ZDR nos dois modos (o "aviso vira bloqueio").
 */
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { decryptSecret } from "./secretCrypto";
import { resolvePlatformChain, resolveByoRoute, ResolvedRoute } from "./llm";

export type PlatformOrder = "auto" | "openrouter-first" | "opencode-only" | "openrouter-only";

/** Produtos de IA que escolhem a própria rota (Configurações → IA). */
export type AiProduct = "copilot" | "attendant" | "vision";

export interface ProductRouting {
  order?: PlatformOrder;
  /** Só a visão usa: ausente significa "Automático" (a cadeia inteira). */
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
  return perProduct ?? providerConfig?.platformOrder ?? envPlatformOrder();
}

export async function resolveOrgRoutes(
  ctx: RunQueryCtx,
  organizationId: Id<"organizations">,
  providerConfig: OrgProviderConfig | null | undefined,
  canonicalModel: string,
  product?: AiProduct
): Promise<ResolvedRoute[]> {
  let routes: ResolvedRoute[];

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
        canonicalModel
      ),
    ];
  } else {
    routes = applyPlatformOrder(
      resolvePlatformChain(canonicalModel, {
        opencodeGoKey: process.env.OPENCODE_GO_API,
        openrouterKey: process.env.OPENROUTER_API_KEY,
      }),
      effectivePlatformOrder(providerConfig, product)
    );
  }

  if (providerConfig?.strictZdr) {
    routes = routes.filter((r) => r.zdr.zdrCapable);
  }
  return routes;
}
