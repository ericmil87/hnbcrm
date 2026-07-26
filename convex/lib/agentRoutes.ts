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

export interface OrgProviderConfig {
  mode?: "platform" | "byo";
  byo?: {
    provider: string;
    baseUrl?: string;
    apiKeyRef: { kind: "orgSecret"; id: Id<"orgSecrets"> };
  };
  strictZdr?: boolean;
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
    routes = resolvePlatformChain(canonicalModel, {
      opencodeGoKey: process.env.OPENCODE_GO_API,
      openrouterKey: process.env.OPENROUTER_API_KEY,
    });
  }

  if (providerConfig?.strictZdr) {
    routes = routes.filter((r) => r.zdr.zdrCapable);
  }
  return routes;
}
