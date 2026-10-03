/**
 * Origem do lead a partir do anúncio Click-to-WhatsApp (Meta `referral`).
 * Primeiro toque: o ingest só grava quando o lead ainda não tem `attribution`,
 * e só numa org com o módulo `attribution` ligado. `messages.metadata.referral`
 * é gravado SEMPRE (é o dado cru), então ligar o módulo depois permite backfill.
 */
import { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { normalizeCampaignKey } from "./orgModules";

export function attributionFromReferral(
  referral: unknown,
  now: number
): NonNullable<Doc<"leads">["attribution"]> | null {
  if (!referral || typeof referral !== "object") return null;
  const r = referral as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const adId = str(r.sourceId);
  const headline = str(r.headline);
  if (!adId && !headline && !str(r.sourceUrl) && !str(r.ctwaClid)) return null;
  const attribution: NonNullable<Doc<"leads">["attribution"]> = {
    // "post" = post impulsionado/orgânico do Instagram/Facebook, não anúncio.
    source: r.sourceType === "post" ? "instagram" : "meta_ads",
    capturedAt: now,
  };
  if (adId) attribution.adId = adId;
  if (headline) {
    attribution.adHeadline = headline;
    // Sem nome de campanha no webhook: o título do anúncio é o melhor rótulo,
    // e a chave normalizada é o que o painel cruza com `adSpend.campaignKey`.
    attribution.campaignName = headline;
    attribution.campaignKey = normalizeCampaignKey(headline);
  }
  const sourceUrl = str(r.sourceUrl);
  if (sourceUrl) attribution.adSourceUrl = sourceUrl;
  const ctwaClid = str(r.ctwaClid);
  if (ctwaClid) attribution.ctwaClid = ctwaClid;
  return attribution;
}

// ---------------------------------------------------------------------------
// T07 — UTM/gclid/fbclid vindos do formulário público e do POST /inbound/lead.
// ---------------------------------------------------------------------------

export type LeadAttribution = NonNullable<Doc<"leads">["attribution"]>;

/** Campos de texto livre que podem chegar do site (todos opcionais). */
export const ATTRIBUTION_TEXT_FIELDS = [
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmTerm",
  "utmContent",
  "gclid",
  "fbclid",
  "fbc",
  "trackingCode",
] as const;
export const ATTRIBUTION_URL_FIELDS = ["landingUrl", "referrer"] as const;
export type AttributionInputKey =
  | (typeof ATTRIBUTION_TEXT_FIELDS)[number]
  | (typeof ATTRIBUTION_URL_FIELDS)[number];
export type AttributionInput = Partial<Record<AttributionInputKey, string>>;

export const ATTRIBUTION_MAX_LENGTH = 200;
export const ATTRIBUTION_MAX_URL_LENGTH = 2048;

const SNAKE_TO_CAMEL: Record<string, AttributionInputKey> = {
  utm_source: "utmSource",
  utm_medium: "utmMedium",
  utm_campaign: "utmCampaign",
  utm_term: "utmTerm",
  utm_content: "utmContent",
  tracking_code: "trackingCode",
  landing_url: "landingUrl",
};

function readKey(obj: Record<string, unknown>, key: AttributionInputKey): unknown {
  if (obj[key] !== undefined) return obj[key];
  for (const [snake, camel] of Object.entries(SNAKE_TO_CAMEL)) {
    if (camel === key && obj[snake] !== undefined) return obj[snake];
  }
  return undefined;
}

/**
 * Lê UTM/click ids do corpo da requisição (chaves planas em snake_case ou
 * camelCase, e/ou um objeto `attribution` em camelCase; as planas vencem).
 * Faz trim, descarta vazio/não-string, corta em 200 (URLs em 2048) e devolve
 * quais campos foram cortados, para o chamador registrar.
 */
export function sanitizeAttributionInput(raw: unknown): {
  input: AttributionInput;
  truncated: AttributionInputKey[];
} {
  const input: AttributionInput = {};
  const truncated: AttributionInputKey[] = [];
  if (!raw || typeof raw !== "object") return { input, truncated };
  const top = raw as Record<string, unknown>;
  const nested =
    top.attribution && typeof top.attribution === "object"
      ? (top.attribution as Record<string, unknown>)
      : {};
  const keys: { key: AttributionInputKey; max: number }[] = [
    ...ATTRIBUTION_TEXT_FIELDS.map((key) => ({ key, max: ATTRIBUTION_MAX_LENGTH })),
    ...ATTRIBUTION_URL_FIELDS.map((key) => ({ key, max: ATTRIBUTION_MAX_URL_LENGTH })),
  ];
  for (const { key, max } of keys) {
    const value = readKey(top, key) ?? readKey(nested, key);
    if (typeof value !== "string") continue;
    let trimmed = value.trim();
    if (!trimmed) continue;
    if ((ATTRIBUTION_URL_FIELDS as readonly string[]).includes(key)) {
      // LGPD: só origem + caminho (query/hash podem ter e-mail, tokens, ids).
      try {
        const u = new URL(trimmed);
        trimmed = u.origin + u.pathname;
      } catch {
        continue;
      }
    }
    if (trimmed.length > max) {
      truncated.push(key);
      input[key] = trimmed.slice(0, max);
    } else {
      input[key] = trimmed;
    }
  }
  return { input, truncated };
}

const PAID_MEDIUM = /^(cpc|ppc|cpm|display|ads?|paid.*|.*paid)$/;
const GOOGLE_ALIASES = new Set(["google", "adwords", "google_ads", "googleads"]);
const META_ALIASES = new Set(["facebook", "fb", "meta", "ig", "instagram", "meta_ads"]);

/**
 * `source` casa com o `source` do gasto em mídia (`adSpend`): click id vence;
 * `utm_source` de mídia PAGA (utm_medium cpc/ppc/paid*...) é mapeado pelos
 * aliases; fora de mídia paga vale o utm_source em minúsculas (instagram
 * orgânico continua "instagram"). fbclid/fbc vencem utm_source=instagram:
 * anúncio pago no Instagram traz exatamente essa combinação.
 */
function deriveSource(input: AttributionInput): string {
  if (input.gclid) return "google_ads";
  if (input.fbclid || input.fbc) return "meta_ads";
  const utmSource = input.utmSource?.toLowerCase();
  if (!utmSource) return "site";
  const medium = input.utmMedium?.toLowerCase().trim().replace(/[\s-]+/g, "_") ?? "";
  if (PAID_MEDIUM.test(medium)) {
    if (GOOGLE_ALIASES.has(utmSource)) return "google_ads";
    if (META_ALIASES.has(utmSource)) return "meta_ads";
  }
  return utmSource;
}

/** Monta a atribuição de entrada; null se o site não mandou nada útil. */
export function buildAttributionFromInput(
  input: AttributionInput,
  now: number
): LeadAttribution | null {
  // landingUrl/referrer sozinhos não são origem de mídia: só acompanham um sinal.
  if (!ATTRIBUTION_TEXT_FIELDS.some((k) => input[k])) return null;
  const source = deriveSource(input);
  const attribution: LeadAttribution = { source, capturedAt: now };
  for (const key of [...ATTRIBUTION_TEXT_FIELDS, ...ATTRIBUTION_URL_FIELDS]) {
    const value = input[key];
    if (value) attribution[key] = value;
  }
  if (input.utmCampaign) {
    const campaignKey = normalizeCampaignKey(input.utmCampaign);
    if (campaignKey) {
      attribution.campaignName = input.utmCampaign;
      attribution.campaignKey = campaignKey;
    }
  }
  return attribution;
}

/**
 * Primeiro toque: só preenche o que ainda está vazio, nunca sobrescreve.
 * `source` e `capturedAt` do existente ficam como estão.
 * Atenção: com `existing.source` já definido, campos vazios preenchidos por um
 * toque posterior misturam toques. Hoje não ocorre (lead do site é sempre
 * novo); se um dia houver lead reaproveitado, decidir a regra antes.
 */
export function mergeFirstTouch(
  existing: LeadAttribution | undefined | null,
  incoming: LeadAttribution | null | undefined
): { merged: LeadAttribution | null; changed: boolean } {
  if (!incoming) return { merged: existing ?? null, changed: false };
  if (!existing) return { merged: incoming, changed: true };
  const merged: LeadAttribution = { ...existing };
  let changed = false;
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "source" || key === "capturedAt") continue;
    if (value === undefined || value === "") continue;
    const current = (merged as Record<string, unknown>)[key];
    if (current === undefined || current === null || current === "") {
      (merged as Record<string, unknown>)[key] = value;
      changed = true;
    }
  }
  return { merged, changed };
}

/** Aplica primeiro toque num lead (mesma transação do chamador). */
export async function applyFirstTouchToLead(
  ctx: { db: MutationCtx["db"] },
  leadId: Id<"leads">,
  incoming: LeadAttribution | null
): Promise<boolean> {
  if (!incoming) return false;
  const lead = await ctx.db.get(leadId);
  if (!lead) return false;
  const { merged, changed } = mergeFirstTouch(lead.attribution, incoming);
  if (!changed || !merged) return false;
  await ctx.db.patch(leadId, { attribution: merged });
  return true;
}
