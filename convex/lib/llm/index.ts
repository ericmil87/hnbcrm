// Endpoint-chain resolution + cross-route fallback.
//
// Two entry points build a ResolvedRoute[]:
//   - resolvePlatformChain: the platform's own keys (OpenCode Go -> OpenRouter),
//     with the ZDR double-lock always applied on the OpenRouter hop.
//   - resolveByoRoute: a single route from an org's own provider/key (no fallback
//     to platform keys — the org pays its own bill).
//
// chatWithFallback then walks a chain, advancing to the next route on quota /
// availability failures and propagating everything else.

import {
  LlmEndpoint,
  LlmHttpError,
  NormalizedRequest,
  NormalizedResponse,
} from "./types";
import {
  OPENROUTER_ZDR_PROVIDER_BODY,
  ProviderId,
  resolveModelId,
  routeInfo,
} from "./registry";
import { chatWithRetry, isUpstreamMislabeled400 } from "./openaiCompatible";

const BASE_URLS: Partial<Record<ProviderId, string>> = {
  "opencode-go": "https://opencode.ai/zen/go/v1",
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
};

export interface ResolvedRoute {
  endpoint: LlmEndpoint;
  providerId: string;
  model: string; // resolved (provider-specific) id
  canonicalModel: string;
  zdr: ReturnType<typeof routeInfo>;
  extraBody?: Record<string, unknown>;
}

function makeRoute(
  providerId: ProviderId,
  baseUrl: string,
  apiKey: string,
  canonicalModel: string,
  extra?: { extraBody?: Record<string, unknown>; extraHeaders?: Record<string, string> }
): ResolvedRoute {
  return {
    endpoint: { providerId, baseUrl, apiKey, extraHeaders: extra?.extraHeaders },
    providerId,
    model: resolveModelId(canonicalModel, providerId),
    canonicalModel,
    zdr: routeInfo(providerId, canonicalModel),
    extraBody: extra?.extraBody,
  };
}

// Platform chain: OpenCode Go first (if its key is present), then OpenRouter
// (only if OPENROUTER_API_KEY exists) with the ZDR double-lock always on. Absent
// the OpenRouter key, the chain is OpenCode Go only — the fallback path is
// implemented but inactive.
export function resolvePlatformChain(
  canonicalModel: string,
  env: { opencodeGoKey?: string; openrouterKey?: string }
): ResolvedRoute[] {
  const chain: ResolvedRoute[] = [];
  if (env.opencodeGoKey) {
    chain.push(makeRoute("opencode-go", BASE_URLS["opencode-go"]!, env.opencodeGoKey, canonicalModel));
  }
  if (env.openrouterKey) {
    chain.push(
      makeRoute("openrouter", BASE_URLS.openrouter!, env.openrouterKey, canonicalModel, {
        extraBody: { ...OPENROUTER_ZDR_PROVIDER_BODY },
      })
    );
  }
  return chain;
}

// BYO: a single route from the org's own credentials. No platform fallback.
export function resolveByoRoute(
  byo: { provider: string; baseUrl?: string; apiKey: string },
  canonicalModel: string
): ResolvedRoute {
  const provider = byo.provider as ProviderId;
  if (provider === "anthropic") {
    throw new Error("Adapter Anthropic ainda não disponível");
  }
  if (provider === "custom") {
    if (!byo.baseUrl) throw new Error("baseUrl é obrigatória para provider 'custom'");
    return makeRoute("custom", byo.baseUrl, byo.apiKey, canonicalModel);
  }
  const baseUrl = BASE_URLS[provider];
  if (!baseUrl) {
    throw new Error(`Provider BYO desconhecido: ${byo.provider}`);
  }
  const extraBody =
    provider === "openrouter" ? { ...OPENROUTER_ZDR_PROVIDER_BODY } : undefined;
  return makeRoute(provider, baseUrl, byo.apiKey, canonicalModel, { extraBody });
}

// Advance to the next route on quota/availability failures: OpenCode Go signals
// tier exhaustion with 4xx quota codes (429/402/403), plus any 5xx / timeout,
// plus o 400 "Upstream request failed" mal-rotulado (transitório — E2E provou).
// Other 4xx (400 bad request genuíno, 401 auth) propagate immediately.
function shouldFallover(err: unknown): boolean {
  if (err instanceof LlmHttpError) {
    return (
      err.status === 429 ||
      err.status === 402 ||
      err.status === 403 ||
      err.status >= 500 ||
      isUpstreamMislabeled400(err)
    );
  }
  // Network / timeout wrapped as a plain Error -> try the next route.
  return err instanceof Error;
}

export async function chatWithFallback(
  routes: ResolvedRoute[],
  req: Omit<NormalizedRequest, "model">,
  opts?: { timeoutMs?: number }
): Promise<NormalizedResponse & { usedRoute: ResolvedRoute }> {
  if (routes.length === 0) throw new Error("Nenhuma rota LLM disponível");
  let lastErr: unknown;
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    const fullReq: NormalizedRequest = {
      ...req,
      model: route.model,
      extraBody: { ...(req.extraBody ?? {}), ...(route.extraBody ?? {}) },
    };
    try {
      const res = await chatWithRetry(route.endpoint, fullReq, {
        timeoutMs: opts?.timeoutMs,
        maxAttempts: 2,
      });
      return { ...res, usedRoute: route };
    } catch (e) {
      lastErr = e;
      const isLast = i === routes.length - 1;
      if (isLast || !shouldFallover(e)) throw e;
      // else: try the next route in the chain
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Todas as rotas LLM falharam");
}
