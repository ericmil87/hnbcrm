/**
 * Origem do lead a partir do anúncio Click-to-WhatsApp (Meta `referral`).
 * Primeiro toque: o ingest só grava quando o lead ainda não tem `attribution`,
 * e só numa org com o módulo `attribution` ligado. `messages.metadata.referral`
 * é gravado SEMPRE (é o dado cru), então ligar o módulo depois permite backfill.
 */
import { Doc } from "../_generated/dataModel";
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
