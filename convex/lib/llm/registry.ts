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
  // Passe de visão: melhor em acurácia (7/7), latência (3,8 s) E custo
  // (495 tokens de imagem, 5,6x menos que os demais) na medição de 2026-08-27.
  vision: "deepseek-v4-flash-vision-exp",
} as const;

// Os papéis que a org PERSISTE em aiConfig.providerConfig.models (schema:
// aiModelsValidator). "vision" fica de fora de propósito: o modelo de visão não
// é escolhido por org — vem da cadeia por rota (VISION_MODELS_BY_PROVIDER), que
// faz fallover próprio. Use isto, e não `{ ...DEFAULT_MODELS }`, ao gravar.
export const DEFAULT_STORED_MODELS = {
  copilot: DEFAULT_MODELS.copilot,
  attendant: DEFAULT_MODELS.attendant,
  classify: DEFAULT_MODELS.classify,
  complex: DEFAULT_MODELS.complex,
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
  // GA do V4 Flash (re-pós-treinado p/ agente/tool use, 31/07/2026). Só existe
  // no OpenRouter — ver OPENROUTER_ONLY_MODELS.
  "deepseek-v4-flash-0731": {
    openrouter: "deepseek/deepseek-v4-flash-0731",
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
  "glm-5.3-flash": {
    openrouter: "z-ai/glm-5.3-flash",
  },
  "mimo-v2.5": {
    openrouter: "xiaomi/mimo-v2.5",
  },
  // NÃO mapear "deepseek-v4-flash-vision-exp" para o OpenRouter: sob o body ZDR
  // (data_collection:"deny") ele devolve 404 "No endpoints found matching your
  // data policy (Paid model training)" — medido em 2026-08-27. Esse modelo só
  // existe pela rota OpenCode Go.
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

// Modelos que NÃO existem no OpenCode Go: a cadeia da plataforma pula aquele elo
// (mandar um id desconhecido só produziria um 4xx que esconde o erro real do elo
// seguinte — foi assim que o 429 do OpenRouter ficou invisível em 19/09/2026).
export const OPENROUTER_ONLY_MODELS: readonly string[] = ["deepseek-v4-flash-0731"];

// Ids confirmed present on OpenCode Go's /v1/models (identical to canonical).
// Lista completa (31 ids) conferida contra o GET /v1/models da API VIVA em
// 2026-08-27 — o registry listava só os 15 primeiros, e faltava justamente o
// "deepseek-v4-flash-vision-exp" que virou o modelo de visão default.
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
  "deepseek-v4-flash-vision-exp",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5",
  "qwen3.8-max",
  "qwen3.6-plus",
  "qwen3.5-plus",
  "kimi-k2.5",
  "minimax-m2.5",
  "longcat-2.0",
  "mimo-v2-pro",
  "mimo-v2-omni",
  "hy3-preview",
  "gpt-5.6-luna",
  "grok-4.6",
  "muse-spark-1.2-contributor",
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
  "deepseek-v4-flash-0731": { jsonSchemaStrict: false },
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

// ── Modelos de visão: allowlist POR ROTA ────────────────────────────────────
//
// POR QUE ALLOWLIST, e não "manda a imagem e vê no que dá": `hy3` e
// `longcat-2.0` ACEITAM o request com a imagem, IGNORAM a imagem em silêncio e
// devolvem todos os campos `null` — sem erro nenhum. O único sinal é a contagem
// de tokens de input (58-66, contra 2.000+ de quem realmente olha). Não há erro
// para detectar em runtime, então a lista tem de ser explícita.
//
// POR QUE POR ROTA, e não uma lista global: a rota OpenRouter carrega o ZDR
// lock ZDR (data_collection:"deny" + require_parameters) e, com esse body
// exato, o MELHOR modelo da cadeia — "deepseek-v4-flash-vision-exp" — devolve
// 404 "No endpoints found matching your data policy (Paid model training)".
// Ele só existe pela rota OpenCode Go.
//
// Todos os ids abaixo foram medidos ao vivo em 2026-08-27 com 7/7 campos de
// acurácia (comprovante de Pix sintético 1080x1920). Fora da lista, por medição:
//   - `kimi-k3` NÃO entra na cadeia OpenRouter: 429 persistente de upstream.
//   - `mimo-v2.5` é último recurso na cadeia OpenRouter: 33 s de latência.
export const VISION_MODELS_BY_PROVIDER: Partial<Record<ProviderId, string[]>> = {
  "opencode-go": ["deepseek-v4-flash-vision-exp", "glm-5.3-flash", "kimi-k3"],
  openrouter: ["glm-5.3-flash", "kimi-k2.7-code", "mimo-v2.5"],
};

// FAIL-CLOSED por desenho: provider desconhecido -> false; modelo fora da lista
// da rota -> false. Nunca relaxar isso (ver a falha silenciosa acima).
export function supportsVision(canonical: string, providerId: string): boolean {
  const chain = VISION_MODELS_BY_PROVIDER[providerId as ProviderId];
  if (!chain) return false;
  return chain.includes(canonical);
}

// Cadeia de visão da rota, na ordem de preferência medida. Fail-closed: rota sem
// modelos de visão devolve [] (quem consome simplesmente não tenta).
export function visionChainFor(providerId: string): string[] {
  return VISION_MODELS_BY_PROVIDER[providerId as ProviderId] ?? [];
}

// Tokens de ENTRADA do prompt de visão SEM imagem nenhuma, por modelo — o maior
// valor entre os provedores medidos pelo OpenRouter em 14/09/2026, com o prompt
// ATUAL (1463 caracteres): glm em 5 provedores, kimi em 5, mimo em 3.
//
// POR QUE EXISTE: em 14/09/2026 três comprovantes reais foram parar num
// provedor do `kimi-k2.7-code` que DESCARTOU a imagem e respondeu 200 com
// "Nenhuma imagem foi enviada" — 425 tokens de entrada, o prompt sozinho. É a
// falha silenciosa do hy3/longcat acontecendo com um modelo DA allowlist, num
// provedor que o OpenRouter escolhe a cada request (então allowlist não pega).
// Qualquer imagem soma tokens — a menor medida (31x96 px) somou +12 a +26 —,
// então input no nível do prompt sozinho significa que a imagem não chegou.
//
// ⚠️ Mudou VISION_SYSTEM_PROMPT ou VISION_USER_PROMPT? RE-MEÇA. O teste
// "mudou o prompt? re-meça" quebra de propósito quando o tamanho do prompt muda.
// Modelo fora do mapa não passa por esta checagem — só pela do campo
// `imagem_recebida`, que o próprio modelo preenche.
export const VISION_TEXT_ONLY_PROMPT_TOKENS: Record<string, number> = {
  "glm-5.3-flash": 426,
  "kimi-k2.7-code": 492,
  "mimo-v2.5": 431,
};

// Folga acima do máximo medido. Entre provedores o mesmo modelo variou até 3
// tokens PARA BAIXO do máximo (kimi 489–492) — coberto por usar o máximo —, e
// a folga fica bem abaixo dos +12 da menor imagem.
const VISION_TEXT_ONLY_TOLERANCE = 2;

// true = a resposta veio de um request em que a imagem não chegou ao modelo.
// Sem medição do modelo ou sem `usage` na resposta, não julga (false).
export function visionImageDropped(canonical: string, promptTokens: number | undefined): boolean {
  const textOnly = VISION_TEXT_ONLY_PROMPT_TOKENS[canonical];
  if (textOnly === undefined || !promptTokens) return false;
  return promptTokens <= textOnly + VISION_TEXT_ONLY_TOLERANCE;
}

// Fatos MEDIDOS de cada modelo de visão (comprovante de Pix sintético 1080x1920,
// 2026-08-27) — servem à UI de Configurações → IA, para o admin escolher com
// número na mão em vez de adivinhar. `accuracy` é campos corretos sobre 7.
export interface VisionModelFacts {
  id: string;
  latencyMs: number;
  inputTokens: number;
  accuracy: string;
  note?: string;
}

const VISION_MODEL_FACTS: Record<string, Omit<VisionModelFacts, "id">> = {
  "deepseek-v4-flash-vision-exp": {
    latencyMs: 3800,
    inputTokens: 495,
    accuracy: "7/7",
    note: "Mais barato: 5,6x menos tokens de imagem que os outros. Experimental (-exp) — pode sumir sem aviso.",
  },
  "glm-5.3-flash": {
    latencyMs: 2900,
    inputTokens: 2751,
    accuracy: "7/7",
    note: "O mais rápido, e o único que funciona nas duas rotas.",
  },
  "kimi-k3": {
    latencyMs: 6100,
    inputTokens: 2839,
    accuracy: "7/7",
  },
  "kimi-k2.7-code": {
    latencyMs: 6300,
    inputTokens: 2757,
    accuracy: "7/7",
  },
  "mimo-v2.5": {
    latencyMs: 33200,
    inputTokens: 2113,
    accuracy: "7/7",
    note: "Lento (33 s) — só como último recurso.",
  },
};

/**
 * Modelos de visão que a org pode FIXAR, com as rotas onde cada um existe e os
 * números medidos. A UI monta o dropdown a partir daqui; a opção "Automático"
 * (ausência de escolha) não vem nesta lista — ela é a cadeia inteira.
 */
export function visionModelOptions(): Array<VisionModelFacts & { providers: ProviderId[] }> {
  const byModel = new Map<string, ProviderId[]>();
  for (const [providerId, chain] of Object.entries(VISION_MODELS_BY_PROVIDER)) {
    for (const id of chain ?? []) {
      byModel.set(id, [...(byModel.get(id) ?? []), providerId as ProviderId]);
    }
  }
  return [...byModel.entries()].map(([id, providers]) => ({
    id,
    providers,
    latencyMs: VISION_MODEL_FACTS[id]?.latencyMs ?? 0,
    inputTokens: VISION_MODEL_FACTS[id]?.inputTokens ?? 0,
    accuracy: VISION_MODEL_FACTS[id]?.accuracy ?? "não medido",
    note: VISION_MODEL_FACTS[id]?.note,
  }));
}

// ── OpenRouter ZDR double-lock (per-request provider object) ────────────────
//
// data_collection:"deny"  -> only providers that don't collect content.
// require_parameters:true  -> only providers supporting tools/json_schema.
// allow_fallbacks:true     -> outro provedor ELEGÍVEL atende quando o primário cai.
//
// `allow_fallbacks` NÃO é o que protege os dados: pela doc do OpenRouter ele só
// decide se provedores de reserva podem atender, e o filtro `data_collection:
// "deny"` vale também para eles. Com `false` o request ia só ao provedor
// PRIMÁRIO e, com ele sobrecarregado, voltava 429 — medido duas vezes: na visão
// em 14/09/2026 e no atendente em 19/09/2026 (`deepseek-v4-flash` 429 em 100%
// das tentativas; com a rota OpenCode Go morta desde 08/09, o atendente ficou
// FORA DO AR em produção). A trava de privacidade é `data_collection`.
export const OPENROUTER_ZDR_PROVIDER_BODY = {
  provider: {
    data_collection: "deny",
    require_parameters: true,
    allow_fallbacks: true,
  },
} as const;

// Pede ao OpenRouter o CUSTO real da chamada (`usage.cost`, USD) no response.
// Não é parâmetro de provider (não afeta `require_parameters`) e não toca a
// trava de privacidade. Só vai na rota OpenRouter (ver `lib/llm/index.ts`).
export const OPENROUTER_USAGE_BODY = { usage: { include: true } } as const;

// ── Preço por modelo (custo de IA — v0.69, T04) ─────────────────────────────
//
// USD por 1M de tokens, por id CANÔNICO. Fonte: `GET https://openrouter.ai/api/v1/models/<slug>/endpoints`
// (API pública, sem chave), coletada em 2026-10-03. Por id: o preço do
// PROVEDOR OFICIAL quando ele aparece entre os endpoints (Moonshot p/ kimi, Z.AI
// p/ glm — a DeepSeek não lista endpoint próprio no OpenRouter), senão a MEDIANA
// de entrada, de saída e de cache entre todos os endpoints pagos.
//
// ⚠️ O `pricing` do TOPO de `/api/v1/models` NÃO é o preço da rota que usamos:
// é o de UM endpoint, quase sempre o mais barato (Relace/InferenceNet). A rota
// ZDR com `allow_fallbacks:true` cai em qualquer endpoint elegível — medido em
// 03/10: `kimi-k3` topo 0,40 de entrada vs Moonshot/Fireworks/DeepInfra
// 2,85–4,5; `glm-5.2` topo 0,06 vs Z.AI 1,40. Por isso a mediana/oficial.
//
// É ESTIMATIVA, não fatura: (1) a rota OpenCode Go é assinatura e não publica
// preço por token — aplicamos esta régua; (2) quando o OpenRouter devolve
// `usage.cost` no response, o custo do PROVEDOR vence esta tabela (ver
// `lib/aiSpend.ts`).
//
// Lição do Deskcomm (4 recorrências): modelo SEM preço não pode custar 0, senão
// o teto de gastos nunca dispara. Daí: (a) só casamento EXATO (nada de
// `startsWith`); (b) modelo desconhecido custa o MAIOR preço da tabela, com
// `costEstimated: true`; (c) `aiSpend.test.ts` quebra o build se algum modelo
// do registry ficar sem linha aqui. Atualizou preço? Atualize a data abaixo.
export interface ModelPrice {
  inPerM: number;
  outPerM: number;
  /** Entrada lida do cache de prefixo. Ausente = cobra como entrada normal. */
  cachedInPerM?: number;
  /** true = sem preço publicado para o id exato; usa o conservador. */
  estimated?: boolean;
}

export const MODEL_PRICES_COLLECTED_AT = "2026-10-03";

// [fonte] = oficial:<provedor> | mediana(<nº de endpoints>)
const PUBLISHED_MODEL_PRICES: Record<string, ModelPrice> = {
  "deepseek-v4-flash": { inPerM: 0.132, outPerM: 0.28, cachedInPerM: 0.0263 }, // mediana(16)
  "deepseek-v4-flash-0731": { inPerM: 0.14, outPerM: 0.528, cachedInPerM: 0.0238 }, // mediana(28)
  "deepseek-v4-pro": { inPerM: 1.358, outPerM: 2.9835, cachedInPerM: 0.1375 }, // mediana(16)
  "deepseek-v4-flash-vision-exp": { inPerM: 0.44, outPerM: 1.32, cachedInPerM: 0.021 }, // mediana(4)
  "kimi-k2.7-code": { inPerM: 0.95, outPerM: 4, cachedInPerM: 0.19 }, // oficial:Moonshot
  "kimi-k3": { inPerM: 3, outPerM: 15, cachedInPerM: 0.3 }, // oficial:Moonshot
  "kimi-k2.6": { inPerM: 0.95, outPerM: 4, cachedInPerM: 0.16 }, // oficial:Moonshot
  "kimi-k2.5": { inPerM: 0.532, outPerM: 2.85, cachedInPerM: 0.1475 }, // mediana(5)
  "glm-5.3-flash": { inPerM: 0.15, outPerM: 0.5, cachedInPerM: 0.03 }, // oficial:Z.AI
  "glm-5.3": { inPerM: 1.4, outPerM: 4.4, cachedInPerM: 0.26 }, // oficial:Z.AI
  "glm-5.2": { inPerM: 1.4, outPerM: 4.4, cachedInPerM: 0.26 }, // oficial:Z.AI
  "glm-5.1": { inPerM: 1.4, outPerM: 4.4, cachedInPerM: 0.26 }, // oficial:Z.AI
  "glm-5": { inPerM: 1, outPerM: 3.2, cachedInPerM: 0.2 }, // oficial:Z.AI
  "mimo-v2.5": { inPerM: 0.168, outPerM: 0.336, cachedInPerM: 0.0034 }, // mediana(5)
  "mimo-v2.5-pro": { inPerM: 0.4575, outPerM: 0.9152, cachedInPerM: 0.0038 }, // mediana(6)
  "qwen3.7-plus": { inPerM: 0.32, outPerM: 1.28, cachedInPerM: 0.064 }, // mediana(1) Alibaba
  "qwen3.7-max": { inPerM: 1.475, outPerM: 4.425, cachedInPerM: 0.295 }, // mediana(1) Alibaba
  "qwen3.6-plus": { inPerM: 0.325, outPerM: 1.95 }, // mediana(1) Alibaba
  // O OpenRouter só publica a versão datada (`qwen/qwen3.5-plus-20260420`).
  "qwen3.5-plus": { inPerM: 0.3, outPerM: 1.8 }, // mediana(1) Alibaba
  "minimax-m3": { inPerM: 0.3, outPerM: 1.2, cachedInPerM: 0.06 }, // mediana(13)
  "minimax-m2.7": { inPerM: 0.3, outPerM: 1.2, cachedInPerM: 0.06 }, // mediana(7)
  "minimax-m2.5": { inPerM: 0.3, outPerM: 1.2, cachedInPerM: 0.045 }, // mediana(8)
  "grok-4.5": { inPerM: 3, outPerM: 9, cachedInPerM: 0.45 }, // mediana(4) xAI
  "grok-4.6": { inPerM: 2.2, outPerM: 6.6, cachedInPerM: 0.55 }, // mediana(6)
  hy3: { inPerM: 0.14, outPerM: 0.58, cachedInPerM: 0.035 }, // mediana(6)
  "hy3-preview": { inPerM: 0.18, outPerM: 0.6, cachedInPerM: 0.06 }, // mediana(1)
  "longcat-2.0": { inPerM: 0.3, outPerM: 1.2, cachedInPerM: 0.006 }, // mediana(1)
  "gpt-5.6-luna": { inPerM: 0.22, outPerM: 1.32, cachedInPerM: 0.022 }, // mediana(7)
  "muse-spark-1.2-contributor": { inPerM: 0.1, outPerM: 0.2, cachedInPerM: 0.002 }, // mediana(1) Meta
};

/**
 * Preço CONSERVADOR: o maior preço de entrada e o maior de saída da tabela
 * publicada (podem vir de modelos diferentes — é teto, não média). É o que um
 * modelo sem preço custa, sempre com `estimated: true`. Nunca 0.
 */
export const CONSERVATIVE_MODEL_PRICE: ModelPrice = (() => {
  const all = Object.values(PUBLISHED_MODEL_PRICES);
  const inPerM = Math.max(...all.map((p) => p.inPerM));
  const outPerM = Math.max(...all.map((p) => p.outPerM));
  return { inPerM, outPerM, cachedInPerM: inPerM, estimated: true };
})();

export const MODEL_PRICES: Record<string, ModelPrice> = {
  ...PUBLISHED_MODEL_PRICES,
  // Ids do OpenCode Go SEM preço publicado para o id EXATO no OpenRouter (lá só
  // existem `qwen3.8-max-0902`/`-prime` e `mimo-v2.5*`) — conservador.
  "qwen3.8-max": CONSERVATIVE_MODEL_PRICE,
  "mimo-v2-pro": CONSERVATIVE_MODEL_PRICE,
  "mimo-v2-omni": CONSERVATIVE_MODEL_PRICE,
};

/**
 * Todo id de modelo que o registry pode mandar a um provider: papéis default,
 * equivalências, catálogo do OpenCode Go, os só-OpenRouter e as cadeias de
 * visão. É a lista que o teste de build confere contra `MODEL_PRICES`.
 */
export function registryModelIds(): string[] {
  const ids = new Set<string>([
    ...Object.values(DEFAULT_MODELS),
    ...Object.keys(MODEL_EQUIVALENCE),
    ...OPENCODE_GO_MODELS,
    ...OPENROUTER_ONLY_MODELS,
    ...Object.values(VISION_MODELS_BY_PROVIDER).flatMap((chain) => chain ?? []),
  ]);
  return [...ids];
}

/**
 * Preço do modelo por casamento EXATO — aceita o id canônico ou o id de um
 * provider (`deepseek/deepseek-v4-flash` → canônico, pela tabela de
 * equivalência). `null` = desconhecido (quem chama aplica o conservador).
 */
export function modelPrice(modelId: string | undefined | null): ModelPrice | null {
  if (!modelId) return null;
  const direct = MODEL_PRICES[modelId];
  if (direct) return direct;
  for (const [canonical, perProvider] of Object.entries(MODEL_EQUIVALENCE)) {
    if (Object.values(perProvider).includes(modelId)) return MODEL_PRICES[canonical] ?? null;
  }
  return null;
}
