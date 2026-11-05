// Filtros de Campanhas que vivem na URL: `?status=&provider=` (replace; o
// padrão "all" fica fora da URL). `?campanha=` (detalhe) segue na página.
import { enumParam } from "./searchParamState";

export const CAMPAIGN_STATUS_FILTER_VALUES = [
  "all",
  "active",
  "draft",
  "paused",
  "completed",
  "canceled",
] as const;
export type CampaignStatusFilter = (typeof CAMPAIGN_STATUS_FILTER_VALUES)[number];

export const CAMPAIGN_PROVIDER_FILTER_VALUES = ["all", "meta", "bridge"] as const;
export type CampaignProviderFilter = (typeof CAMPAIGN_PROVIDER_FILTER_VALUES)[number];

export const campaignStatusCodec = enumParam(CAMPAIGN_STATUS_FILTER_VALUES, "all");
export const campaignProviderCodec = enumParam(CAMPAIGN_PROVIDER_FILTER_VALUES, "all");
