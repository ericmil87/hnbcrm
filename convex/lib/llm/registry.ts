// Source of truth for models and routes.
//
// - DEFAULT_MODELS: canonical model ids per role.
// - MODEL_EQUIVALENCE / resolveModelId: canonical id -> per-provider id.
// - ROUTE_REGISTRY / routeInfo: privacy facts per (provider, canonical model).
// - MODEL_CAPABILITIES / supportsJsonSchemaStrict: per-route feature flags.
//
// IMPORTANT: model ids/prices here are post-cutoff and MUST be confirmed against
// each provider's GET /v1/models before shipping (see docs/AI-AGENT-CONFIG-PLAN-v3
// §8). The OpenCode Go ids below were confirmed via GET /v1/models on the tier.

// ── Canonical default models per role ──────────────────────────────────────

export const DEFAULT_MODELS = {
  copilot: "kimi-k2.7-code",
  attendant: "deepseek-v4-flash",
  classify: "deepseek-v4-flash",
  complex: "deepseek-v4-pro",
} as const;

export type ProviderId =
  | "opencode-go"
  | "openrouter"
  | "openai"
  | "anthropic"
  | "deepseek"
  | "moonshot"
  | "custom";

// ── Model equivalence: canonical id -> provider-specific id ─────────────────
//
// OpenCode Go uses ids identical to the canonical ones (confirmed via
// GET /v1/models), so it is intentionally absent from most maps — resolveModelId
// falls back to the canonical id. Only providers that rename models appear here.

export const MODEL_EQUIVALENCE: Record<string, Partial<Record<ProviderId, string>>> = {
  "deepseek-v4-flash": {
    openrouter: "deepseek/deepseek-v4-flash",
    deepseek: "deepseek-chat",
  },
  "deepseek-v4-pro": {
    openrouter: "deepseek/deepseek-v4-pro",
    deepseek: "deepseek-reasoner",
  },
  "kimi-k2.7-code": {
    openrouter: "moonshotai/kimi-k2.7-code",
    moonshot: "kimi-k2.7-code",
  },
  "kimi-k3": {
    openrouter: "moonshotai/kimi-k3",
    moonshot: "kimi-k3",
  },
  "glm-5.2": {
    openrouter: "z-ai/glm-5.2",
  },
  "qwen3.7-plus": {
    openrouter: "qwen/qwen3.7-plus",
  },
  "minimax-m3": {
    openrouter: "minimax/minimax-m3",
  },
  "grok-4.5": {
    openrouter: "x-ai/grok-4.5",
  },
};

// Ids confirmed present on OpenCode Go's /v1/models (identical to canonical).
export const OPENCODE_GO_MODELS = [
  "minimax-m3",
  "minimax-m2.7",
  "kimi-k3",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "glm-5.2",
  "glm-5.1",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "qwen3.7-max",
  "qwen3.7-plus",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "hy3",
  "grok-4.5",
] as const;

export function resolveModelId(canonical: string, providerId: string): string {
  const perProvider = MODEL_EQUIVALENCE[canonical];
  const mapped = perProvider?.[providerId as ProviderId];
  // Fallback: canonical id unchanged (correct for opencode-go and for any
  // provider whose ids already match the canonical set).
  return mapped ?? canonical;
}

// ── Route registry: privacy / residency facts per (provider, canonical) ─────
//
// zdrCapable is a property of the ROUTE (provider + model + tier), not the
// provider — a model can be zero-retention on a paid gateway and training-data
// on its free tier. The default (routeInfo, below) is intentionally conservative.

export interface RouteInfo {
  zdrCapable: boolean;
  dataResidency: string;
  retention: string;
  trainsOnData: boolean;
  notes?: string;
}

// Facts for the paid OpenCode Go models: US residency, zero retention.
function opencodeGoPaid(notes?: string): RouteInfo {
  return { zdrCapable: true, dataResidency: "US", retention: "zero", trainsOnData: false, notes };
}

// OpenRouter under the ZDR double-lock (data_collection: "deny") -> zero retention.
function openrouterZdr(): RouteInfo {
  return {
    zdrCapable: true,
    dataResidency: "varia (só providers ZDR)",
    retention: "zero",
    trainsOnData: false,
    notes: "Exige a trava dupla OPENROUTER_ZDR_PROVIDER_BODY por request.",
  };
}

// Per-provider defaults, applied to every canonical model on that provider
// unless a more specific entry overrides it.
const PROVIDER_DEFAULTS: Partial<Record<ProviderId, RouteInfo>> = {
  "opencode-go": opencodeGoPaid(),
  openrouter: openrouterZdr(),
  // DeepSeek direct (platform.deepseek.com): China residency, trains on data.
  deepseek: {
    zdrCapable: false,
    dataResidency: "CN",
    retention: "~30d",
    trainsOnData: true,
    notes: "API direta chinesa — transferência internacional sensível (LGPD Art. 33). Prefira via gateway US.",
  },
  // Moonshot/Kimi direct: Singapore, no product-level training opt-out.
  moonshot: {
    zdrCapable: false,
    dataResidency: "SG",
    retention: "desconhecida",
    trainsOnData: false,
    notes: "Sem opt-out de treino em nível de produto; jurisdição final incerta.",
  },
  // OpenAI direct: no API training since 2023, ~30d abuse retention; ZDR only
  // with a commercial agreement (not assumed here).
  openai: {
    zdrCapable: false,
    dataResidency: "US",
    retention: "30d",
    trainsOnData: false,
    notes: "ZDR só com acordo comercial (sales).",
  },
  // Anthropic direct: ZDR by agreement only.
  anthropic: {
    zdrCapable: false,
    dataResidency: "US",
    retention: "30d",
    trainsOnData: false,
    notes: "ZDR por acordo (sales); Fable 5 exige 30d de retenção.",
  },
};

// Specific (provider, canonical) overrides. Free-tier Zen models train on data.
const ROUTE_OVERRIDES: Record<string, RouteInfo> = {
  // Free Zen variants (suffix "-free") — used for training during the free period.
  "opencode-go:deepseek-v4-flash-free": {
    zdrCapable: false,
    dataResidency: "US",
    retention: "desconhecida",
    trainsOnData: true,
    notes: "Modelo FREE do Zen — usa dados para treino durante o período grátis. Fora do ZDR.",
  },
  // OpenAI/Anthropic routed VIA Zen retain 30 days -> outside ZDR.
  "opencode-go:gpt-via-zen": {
    zdrCapable: false,
    dataResidency: "US",
    retention: "30d",
    trainsOnData: false,
    notes: "OpenAI via Zen retém 30 dias — fora do ZDR.",
  },
  "opencode-go:claude-via-zen": {
    zdrCapable: false,
    dataResidency: "US",
    retention: "30d",
    trainsOnData: false,
    notes: "Anthropic via Zen retém 30 dias — fora do ZDR.",
  },
};

export const ROUTE_REGISTRY = { PROVIDER_DEFAULTS, ROUTE_OVERRIDES } as const;

const CONSERVATIVE_DEFAULT: RouteInfo = {
  zdrCapable: false,
  dataResidency: "desconhecida",
  retention: "desconhecida",
  trainsOnData: false,
};

export function routeInfo(providerId: string, canonicalModel: string): RouteInfo {
  const override = ROUTE_OVERRIDES[`${providerId}:${canonicalModel}`];
  if (override) return override;
  // Any model id carrying the free-tier suffix is treated as training-on-data.
  if (providerId === "opencode-go" && canonicalModel.endsWith("-free")) {
    return {
      zdrCapable: false,
      dataResidency: "US",
      retention: "desconhecida",
      trainsOnData: true,
      notes: "Modelo FREE do Zen — fora do ZDR.",
    };
  }
  const providerDefault = PROVIDER_DEFAULTS[providerId as ProviderId];
  return providerDefault ?? CONSERVATIVE_DEFAULT;
}

// ── Model capabilities: per-route feature flags ─────────────────────────────
//
// jsonSchemaStrict gates whether we can rely on response_format json_schema
// with strict:true. Where NOT confirmed, the runtime must fall back to
// json_object + zod validation. OpenAI is the only route with a guarantee.

export interface ModelCapabilities {
  jsonSchemaStrict: boolean;
}

// Keyed by canonical model id — provider-specific exceptions handled in
// supportsJsonSchemaStrict below.
export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  // DeepSeek / Kimi strict json_schema via OpenCode Go is NOT CONFIRMED.
  "deepseek-v4-flash": { jsonSchemaStrict: false },
  "deepseek-v4-pro": { jsonSchemaStrict: false },
  "kimi-k2.7-code": { jsonSchemaStrict: false },
  "kimi-k3": { jsonSchemaStrict: false },
};

export function supportsJsonSchemaStrict(canonical: string, providerId: string): boolean {
  // OpenAI direct guarantees strict schema adherence for any model we route there.
  if (providerId === "openai") return true;
  const cap = MODEL_CAPABILITIES[canonical];
  // Unknown model -> conservative false (use json_object + runtime validation).
  return cap?.jsonSchemaStrict ?? false;
}

// ── OpenRouter ZDR double-lock (per-request provider object) ────────────────
//
// data_collection:"deny"  -> only providers that don't collect content.
// require_parameters:true  -> only providers supporting tools/json_schema.
// allow_fallbacks:false    -> never silently fall through to a non-ZDR route.
export const OPENROUTER_ZDR_PROVIDER_BODY = {
  provider: {
    data_collection: "deny",
    require_parameters: true,
    allow_fallbacks: false,
  },
} as const;
