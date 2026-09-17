import type { Id } from "../../../convex/_generated/dataModel";

// Espelhos TS dos validators de convex/schema.ts (campanhas). O backend devolve
// v.any() nas queries de leitura, então estes tipos são a referência da UI.

export type CampaignProvider = "meta" | "bridge";

export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "running"
  | "paused"
  | "completed"
  | "canceled"
  | "failed";

export type RecipientStatus =
  | "pending"
  | "queued"
  | "sent"
  | "delivered"
  | "read"
  | "replied"
  | "failed"
  | "skipped"
  | "opted_out";

export interface CampaignPacing {
  minDelaySec: number;
  maxDelaySec: number;
  batchSize: number;
  batchPauseMin: number;
  maxPerHour: number;
  maxPerDay: number;
  maxNewContactsPerDay?: number;
  respectWarmup?: boolean;
}

export interface CampaignSchedule {
  startAt?: number;
  timezone: string;
  windowStartHour: number;
  windowEndHour: number;
  days: number[];
}

export interface CampaignVariant {
  text: string;
  attachmentFileIds?: Id<"files">[];
}

export interface TemplateParam {
  source: "field" | "const";
  value: string;
}

export interface CampaignTemplate {
  name: string;
  language: string;
  category?: string;
  headerFileId?: Id<"files">;
  headerFormat?: string;
  bodyParams?: TemplateParam[];
  headerParams?: TemplateParam[];
  buttonParams?: TemplateParam[];
  bodyText?: string;
}

export type CampaignContentType = "text" | "image" | "file" | "audio";

export interface CampaignContent {
  kind: "text" | "template";
  variants: CampaignVariant[];
  contentType?: CampaignContentType;
  template?: CampaignTemplate;
}

export interface AudienceFilters {
  boardId?: Id<"boards">;
  stageIds?: Id<"stages">[];
  tags?: string[];
  assignedTo?: Id<"teamMembers">;
  temperature?: "cold" | "warm" | "hot";
  priority?: "low" | "medium" | "high" | "urgent";
  lastActivityBefore?: number;
  lastActivityAfter?: number;
  onlyOpenWindow?: boolean;
  excludeCampaignedWithinDays?: number;
  excludeRepliedToCampaigns?: boolean;
}

/** v0.57: "groups" = a SALA é o destinatário; "group_members" = DM 1 a 1. */
export type AudienceSource = "segment" | "import" | "manual" | "groups" | "group_members";

export interface MemberFilters {
  excludeAdmins?: boolean;
  excludeExistingContacts?: boolean;
  excludeCampaignedWithinDays?: number;
  activeInGroupWithinDays?: number;
  excludeGroupChatIds?: Id<"groupChats">[];
  /**
   * Seleção explícita de pessoas (chave do participante = `lid ?? phone`).
   * Ausente = todos os elegíveis. Os demais filtros continuam valendo por cima.
   */
  includeKeys?: string[];
}

/** Por que um membro do grupo ficou de fora do disparo. */
export type MemberExclusionReason =
  | "self"
  | "left"
  | "no_phone"
  | "invalid_phone"
  | "duplicate"
  | "opted_out"
  | "admin"
  | "existing_contact"
  | "campaigned_recently"
  | "inactive_in_group"
  | "in_excluded_group"
  | "not_selected";

/** Uma linha da lista "quem vai receber" (prévia do público `group_members`). */
export interface PreviewMemberRow {
  key: string;
  name?: string;
  phoneMasked: string;
  /** Número inteiro — só vem para quem tem `inbox:view_all`. */
  phone?: string;
  isAdmin: boolean;
  groupChatId: Id<"groupChats">;
  groupSubject: string;
  isContact: boolean;
  /** Ausente = entra no disparo. */
  excludedReason?: MemberExclusionReason;
}

export interface CampaignAudience {
  source: AudienceSource;
  filters?: AudienceFilters;
  groupChatIds?: Id<"groupChats">[];
  memberFilters?: MemberFilters;
  importFileId?: Id<"files">;
  targetBoardId?: Id<"boards">;
  targetStageId?: Id<"stages">;
  targetTags?: string[];
  snapshotAt?: number;
  total?: number;
}

export interface CampaignSafetyInput {
  checkNumbersFirst?: boolean;
  allowLinks?: boolean;
  stopOnReplyRateBelow?: number | null;
  stopOnDeliveryRateBelow?: number | null;
  minSampleForKillSwitch?: number;
  maxConsecutiveFailures?: number;
}

export interface CampaignStats {
  total: number;
  pending: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  skipped: number;
  optedOut: number;
  consecutiveFailures: number;
  estimatedCostUsd?: number;
}

export interface ChannelSummary {
  _id: Id<"channelConfigs">;
  displayName: string;
  provider: CampaignProvider;
  displayPhoneNumber: string | null;
  status: "active" | "disabled" | "error";
  bridgeSessionState: string | null;
  connectedAt: number;
}

export interface CampaignListItem {
  _id: Id<"campaigns">;
  name: string;
  description: string | null;
  status: CampaignStatus;
  provider: CampaignProvider;
  contentKind: "text" | "template";
  channel: ChannelSummary | null;
  creatorName: string | null;
  stats: CampaignStats;
  pausedReason: string | null;
  audienceSource: AudienceSource;
  startedAt: number | null;
  completedAt: number | null;
  scheduledStartAt: number | null;
  nextTickAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TimelineEntry {
  at: number;
  kind: string;
  detail?: string;
  actorId?: string;
}

export interface CampaignDoc {
  _id: Id<"campaigns">;
  organizationId: Id<"organizations">;
  name: string;
  description?: string;
  status: CampaignStatus;
  channelConfigId: Id<"channelConfigs">;
  provider: CampaignProvider;
  content: CampaignContent;
  audience: CampaignAudience;
  schedule: CampaignSchedule;
  pacing: CampaignPacing;
  safeMode: boolean;
  safety: CampaignSafetyInput & {
    consentAck?: { acceptedAt: number; acceptedBy: string };
    bridgeRiskAck?: { acceptedAt: number; acceptedBy: string };
    newNumberRiskAck?: { acceptedAt: number; acceptedBy: string };
    groupMembersDmAck?: { acceptedAt: number; acceptedBy: string };
  };
  stats: CampaignStats;
  timeline?: TimelineEntry[];
  pausedReason?: string;
  lastError?: string;
  tierAtLaunch?: string;
  templateQualityAtLaunch?: string;
  createdBy: Id<"teamMembers">;
  startedAt?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
  channel: ChannelSummary | null;
  creatorName: string | null;
  targetBoardName: string | null;
  targetStageName: string | null;
}

export interface CampaignRecipient {
  _id: Id<"campaignRecipients">;
  campaignId: Id<"campaigns">;
  phone: string;
  displayName?: string;
  vars?: Record<string, string>;
  contactId?: Id<"contacts">;
  leadId?: Id<"leads">;
  conversationId?: Id<"conversations">;
  messageId?: Id<"messages">;
  status: RecipientStatus;
  variantIndex?: number;
  attempts: number;
  scheduledFor?: number;
  errorCode?: number;
  lastError?: string;
  skipReason?: string;
  isNewContact?: boolean;
  sentAt?: number;
  deliveredAt?: number;
  readAt?: number;
  repliedAt?: number;
  createdAt: number;
}

export interface CampaignReport {
  campaignId: Id<"campaigns">;
  name: string;
  status: CampaignStatus;
  provider: CampaignProvider;
  stats: CampaignStats;
  dispatched: number;
  attempted: number;
  rates: {
    delivered: number | null;
    read: number | null;
    replied: number | null;
    failed: number | null;
    optedOut: number | null;
  };
  errorBreakdown: Record<string, number>;
  skipBreakdown: Record<string, number>;
  estimatedCostUsd: number | null;
  tierAtLaunch: string | null;
  templateQualityAtLaunch: string | null;
  timeline: TimelineEntry[];
  pausedReason: string | null;
  startedAt: number | null;
  completedAt: number | null;
  progress: number;
  /** Só nos públicos de grupo (vazio nos demais). */
  byGroup: CampaignGroupBreakdown[];
  audienceSource: AudienceSource;
}

export interface SafeDefaults {
  provider: CampaignProvider;
  warmupDay: number;
  connectedAt: number;
  safe: CampaignPacing;
  orgDefaults: CampaignPacing | null;
  hardCap: {
    maxPerDay: number;
    maxPerHour: number;
    minDelaySec: number;
    maxNewContactsPerDay: number | null;
  };
  newNumberRisk: string | null;
  warmupWarning: string | null;
  tier: string | null;
  schedule: CampaignSchedule;
  safety: CampaignSafetyInput;
  /** Teto de membros por grupo de origem/dia (público "group_members"). */
  perGroupPerDay?: number;
}

export interface WhatsappTemplateItem {
  _id: string;
  metaId: string;
  name: string;
  language: string;
  category: string;
  status: string;
  qualityScore: string | null;
  components: unknown;
  syncedAt: number;
  bodyText: string | null;
  headerFormat: string | null;
  bodyParamCount: number;
  buttons: { type: string; text: string; url?: string; dynamic?: boolean }[];
}

/** Funil do público de membros de grupo (§7.1 do plano de grupos). */
export interface AudienceFunnel {
  total: number;
  withPhone: number;
  deduped: number;
  afterOptOut: number;
  afterFilters: number;
  final: number;
}

export interface AudiencePreview {
  count: number;
  sample: {
    leadId?: string;
    contactId?: string;
    phone?: string;
    displayName?: string | null;
    vars?: Record<string, string>;
    // públicos de grupo
    name?: string | null;
    group?: string;
    groupChatId?: Id<"groupChats">;
    participantsCount?: number;
  }[];
  excluded: Record<string, number>;
  scanned: number;
  truncated: boolean;
  /** Público de membros: quantos o teto cortou, e qual é o teto. */
  overLimit?: number;
  limit?: number;
  source?: AudienceSource;
  funnel?: AudienceFunnel | null;
  perGroup?: { groupChatId: Id<"groupChats">; subject: string; count: number }[];
  estimatedDays?: number;
  perGroupPerDay?: number;
  /**
   * Público "group_members": a prévia RECUSOU o público (hoje: o CRM não sabe
   * qual é o nosso número naquelas salas). Vem como dado, não como exceção,
   * para a tela explicar em vez de sumir.
   */
  blockedReason?: string;
  /**
   * Público "group_members": TODO MUNDO que ainda está nas salas escolhidas,
   * com o motivo de quem ficou de fora. É a lista da seção "Quem vai receber".
   * `membersTruncated` é sobre ESTA lista (teto `membersLimit`), não sobre o
   * público — esse é `truncated`/`overLimit`.
   */
  members?: PreviewMemberRow[];
  membersTruncated?: boolean;
  membersTotal?: number;
  membersLimit?: number;
  /** Público "groups": soma dos membros das salas (alcance estimado). */
  reach?: number;
  skipped?: { subject: string; reason: string }[];
}

export interface CampaignGroupBreakdown {
  groupChatId: string;
  subject: string;
  total: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  skipped: number;
  pending: number;
}

/** Item da lista de grupos monitorados (convex/groupChats.listGroups). */
export interface MonitoredGroup {
  _id: Id<"groupChats">;
  subject: string;
  jid: string;
  channelConfigId: Id<"channelConfigs">;
  conversationId?: Id<"conversations">;
  monitored: boolean;
  participantsCount: number;
  lastMessageAt?: number;
  removedAt?: number;
  leftAt?: number;
}

export interface ImportMapping {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  varsColumns?: string[];
}

export interface ImportDryRunHeaders {
  headers: string[];
  rowCount: number;
  suggestedMapping: { phone: string | null; name: string | null; email: string | null; company: string | null };
  preview: Record<string, string>[];
}

export interface ImportDryRunSummary extends ImportDryRunHeaders {
  valid: number;
  invalid: { row: number; phone: string; reason: string }[];
  invalidCount: number;
  duplicates: number;
  suppressed: number;
  existingContacts: number;
  added?: number;
  duplicatesInCampaign?: number;
}

export interface ChannelConfigItem {
  _id: Id<"channelConfigs">;
  provider: CampaignProvider;
  displayName: string;
  displayPhoneNumber: string | null;
  wabaId: string | null;
  status: "active" | "disabled" | "error";
  bridgeSessionState: string | null;
}
