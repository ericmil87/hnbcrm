import type { Id } from "../../../convex/_generated/dataModel";
import type {
  AudienceFilters,
  AudienceSource,
  CampaignContent,
  CampaignDoc,
  CampaignPacing,
  CampaignProvider,
  CampaignSafetyInput,
  CampaignSchedule,
} from "./types";

export const WIZARD_STEPS = ["channel", "audience", "message", "limits", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const WIZARD_STEP_LABELS: Record<WizardStep, string> = {
  channel: "Canal",
  audience: "Público",
  message: "Mensagem",
  limits: "Limites",
  review: "Revisão",
};

export interface WizardDraft {
  name: string;
  description: string;
  channelConfigId: Id<"channelConfigs"> | null;
  provider: CampaignProvider | null;
  content: CampaignContent;
  audience: {
    source: AudienceSource;
    filters: AudienceFilters;
    importFileId?: Id<"files">;
    targetBoardId?: Id<"boards">;
    targetStageId?: Id<"stages">;
    targetTags: string[];
  };
  schedule: CampaignSchedule | null;
  pacing: CampaignPacing | null;
  safeMode: boolean;
  safety: CampaignSafetyInput;
  // Só no cliente
  tierAtLaunch: string | null;
  templateQuality: string | null;
  overrideWord: string;
}

export const DEFAULT_VARIANT_TEXT = "Olá {{primeiro_nome|tudo bem}}! ";

export function emptyDraft(): WizardDraft {
  return {
    name: "",
    description: "",
    channelConfigId: null,
    provider: null,
    content: { kind: "text", variants: [{ text: DEFAULT_VARIANT_TEXT }], contentType: "text" },
    audience: { source: "segment", filters: {}, targetTags: [] },
    schedule: null,
    pacing: null,
    safeMode: true,
    safety: {},
    tierAtLaunch: null,
    templateQuality: null,
    overrideWord: "",
  };
}

export function draftFromCampaign(c: CampaignDoc): WizardDraft {
  return {
    name: c.name,
    description: c.description ?? "",
    channelConfigId: c.channelConfigId,
    provider: c.provider,
    content: {
      kind: c.content.kind,
      variants: c.content.variants.length > 0 ? c.content.variants : [{ text: "" }],
      contentType: c.content.contentType ?? "text",
      template: c.content.template,
    },
    audience: {
      source: c.audience.source,
      filters: c.audience.filters ?? {},
      importFileId: c.audience.importFileId,
      targetBoardId: c.audience.targetBoardId,
      targetStageId: c.audience.targetStageId,
      targetTags: c.audience.targetTags ?? [],
    },
    schedule: c.schedule,
    pacing: c.pacing,
    safeMode: c.safeMode,
    safety: {
      checkNumbersFirst: c.safety.checkNumbersFirst,
      allowLinks: c.safety.allowLinks,
      stopOnReplyRateBelow: c.safety.stopOnReplyRateBelow ?? null,
      stopOnDeliveryRateBelow: c.safety.stopOnDeliveryRateBelow ?? null,
      minSampleForKillSwitch: c.safety.minSampleForKillSwitch,
      maxConsecutiveFailures: c.safety.maxConsecutiveFailures,
    },
    tierAtLaunch: c.tierAtLaunch ?? null,
    templateQuality: c.templateQualityAtLaunch ?? null,
    overrideWord: "",
  };
}

/** Remove chaves `undefined` (o Convex já ignora, mas mantém o payload limpo). */
function compact<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

export function contentPayload(draft: WizardDraft): CampaignContent {
  const kind = draft.content.kind;
  if (kind === "template") {
    return compact({
      kind,
      variants: [],
      template: draft.content.template ? compact(draft.content.template) : undefined,
    }) as CampaignContent;
  }
  const variants = draft.content.variants.map((vr) =>
    compact({
      text: vr.text,
      attachmentFileIds: vr.attachmentFileIds && vr.attachmentFileIds.length > 0 ? vr.attachmentFileIds : undefined,
    })
  );
  return compact({ kind, variants, contentType: draft.content.contentType ?? "text" }) as CampaignContent;
}

export function audiencePayload(draft: WizardDraft) {
  const filters = compact({ ...draft.audience.filters });
  const cleanFilters: AudienceFilters = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v === "" || v === null || (Array.isArray(v) && v.length === 0)) continue;
    (cleanFilters as Record<string, unknown>)[k] = v;
  }
  return compact({
    source: draft.audience.source,
    filters: draft.audience.source === "segment" ? cleanFilters : undefined,
    importFileId: draft.audience.importFileId,
    targetBoardId: draft.audience.targetBoardId,
    targetStageId: draft.audience.targetStageId,
    targetTags: draft.audience.targetTags.length > 0 ? draft.audience.targetTags : undefined,
  });
}

export function safetyPayload(draft: WizardDraft): CampaignSafetyInput {
  return compact({
    checkNumbersFirst: draft.safety.checkNumbersFirst,
    allowLinks: draft.safety.allowLinks,
    stopOnReplyRateBelow: draft.safety.stopOnReplyRateBelow,
    stopOnDeliveryRateBelow: draft.safety.stopOnDeliveryRateBelow,
    minSampleForKillSwitch: draft.safety.minSampleForKillSwitch,
    maxConsecutiveFailures: draft.safety.maxConsecutiveFailures,
  });
}

export function schedulePayload(schedule: CampaignSchedule): CampaignSchedule {
  return compact({ ...schedule }) as CampaignSchedule;
}

export function pacingPayload(pacing: CampaignPacing): CampaignPacing {
  return compact({ ...pacing }) as CampaignPacing;
}

export function isWithinSafe(pacing: CampaignPacing, safe: CampaignPacing): boolean {
  return (
    pacing.maxPerDay <= safe.maxPerDay &&
    pacing.maxPerHour <= safe.maxPerHour &&
    pacing.minDelaySec >= safe.minDelaySec &&
    (pacing.maxNewContactsPerDay ?? Infinity) <= (safe.maxNewContactsPerDay ?? Infinity)
  );
}

/** Variáveis disponíveis para inserir no texto: fixas + as do CSV (vars dos destinatários). */
export const BUILTIN_VARS = [
  { key: "nome", label: "Nome completo" },
  { key: "primeiro_nome", label: "Primeiro nome" },
  { key: "empresa", label: "Empresa" },
  { key: "email", label: "E-mail" },
];

export const SAMPLE_RECIPIENT_VARS: Record<string, string> = {
  nome: "Maria Silva",
  primeiro_nome: "Maria",
  empresa: "Padaria da Maria",
  email: "maria@exemplo.com",
};
