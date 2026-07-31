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

export interface OrgProviderConfig {
  mode?: "platform" | "byo";
  byo?: {
    provider: string;
    baseUrl?: string;
    apiKeyRef: { kind: "orgSecret"; id: Id<"orgSecrets"> };
  };
  strictZdr?: boolean;
  platformOrder?: PlatformOrder;
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

export async function resolveOrgRoutes(
  ctx: RunQueryCtx,
  organizationId: Id<"organizations">,
  providerConfig: OrgProviderConfig | null | undefined,
  canonicalModel: string
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
    // Precedência: escolha da org > override de ops do deployment (env
    // LLM_PLATFORM_ORDER, p/ ex. "openrouter-first" enquanto a quota do
    // OpenCode Go está esgotada) > auto.
    routes = applyPlatformOrder(
      resolvePlatformChain(canonicalModel, {
        opencodeGoKey: process.env.OPENCODE_GO_API,
        openrouterKey: process.env.OPENROUTER_API_KEY,
      }),
      providerConfig?.platformOrder ?? envPlatformOrder()
    );
  }

  if (providerConfig?.strictZdr) {
    routes = routes.filter((r) => r.zdr.zdrCapable);
  }
  return routes;
}
