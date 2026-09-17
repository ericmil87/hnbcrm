/**
 * Tipos da aba "Publicações" (F3). As queries `api.groupPosts.*` devolvem
 * `v.any()` — o formato real está em `convex/groupPosts.ts` (`list`, `get`,
 * `getHistory`) e em `convex/schema.ts` (tabela `groupPosts`). Estes tipos são
 * a leitura do cliente para esse contrato; mudou lá, muda aqui.
 */
import type { Id } from "../../../../convex/_generated/dataModel";

export type GroupPostStatus = "draft" | "active" | "paused" | "ended";

export type GroupPostSchedule = {
  timezone: string;
  /** "HH:MM" locais, 1..10. */
  times: string[];
  /** 1..7 (1 = segunda … 7 = domingo). */
  days: number[];
  startAt?: number;
  endAt?: number;
  jitterMinutes?: number;
};

export type GroupPostContentType = "text" | "image" | "file" | "audio";

export interface GroupPostLibraryItem {
  text: string;
  attachmentFileIds?: Id<"files">[];
  contentType?: GroupPostContentType;
}

export interface GroupPostLibrary {
  items: GroupPostLibraryItem[];
  order: "sequential" | "random";
  noRepeatWindow?: number;
  cursor?: number;
  recentIndexes?: number[];
}

export interface GroupPostAi {
  prompt: string;
  persona?: "attendant" | "custom";
  customPersona?: string;
  useKnowledge: boolean;
  maxChars?: number;
  generateMinutesBefore: number;
  requiresApproval: boolean;
  onMissedApproval: "skip" | "send";
}

export interface GroupPostContent {
  kind: "library" | "ai";
  library?: GroupPostLibrary;
  ai?: GroupPostAi;
}

export interface GroupPostPending {
  text: string;
  attachmentFileIds?: Id<"files">[];
  generatedAt: number;
  /** Instante do slot a que este texto pertence — é a contagem regressiva. */
  dueAt: number;
  slotKey: string;
  status: "pendingApproval" | "approved" | "rejected";
  approvedBy?: Id<"teamMembers">;
  editedText?: string;
  model?: string;
  provider?: string;
}

export interface GroupPostStats {
  sent: number;
  skipped: number;
  failed: number;
  lastSentAt?: number;
  lastError?: string;
}

interface GroupPostBase {
  _id: Id<"groupPosts">;
  _creationTime: number;
  organizationId: Id<"organizations">;
  name: string;
  status: GroupPostStatus;
  channelConfigId: Id<"channelConfigs">;
  schedule: GroupPostSchedule;
  content: GroupPostContent;
  pending?: GroupPostPending;
  stats: GroupPostStats;
  nextRunAt?: number;
  pausedReason?: string;
  startedAt?: number;
  endedAt?: number;
  createdAt: number;
  updatedAt: number;
  /** Agenda em PT-BR, já montada pelo servidor. */
  scheduleText: string;
}

/** Linha de `api.groupPosts.list` (sem `timeline`). */
export interface GroupPostListItem extends GroupPostBase {
  targets: { groupChatId: Id<"groupChats"> }[];
  targetNames: string[];
  pendingApproval?: GroupPostPending;
}

export interface GroupPostTarget {
  groupChatId: Id<"groupChats">;
  subject: string;
  jid?: string;
  conversationId?: Id<"conversations">;
  monitored: boolean;
  /** Saiu ou foi removido — o número não posta mais ali. */
  left: boolean;
}

export interface GroupPostChannel {
  _id: Id<"channelConfigs">;
  displayName: string;
  sessionState?: string;
  groupsEnabled: boolean;
  status: "active" | "disabled" | "error";
}

/** Retorno de `api.groupPosts.get`. */
export interface GroupPostDetailDoc extends GroupPostBase {
  targets: GroupPostTarget[];
  channel: GroupPostChannel | null;
}

export interface GroupPostSend {
  groupChatId: Id<"groupChats">;
  subject: string;
  conversationId?: Id<"conversations">;
  messageId?: Id<"messages">;
  error?: string;
}

/** Linha de `api.groupPosts.getHistory`. */
export interface GroupPostHistoryEntry {
  at: number;
  kind: "sent" | "skipped" | "failed";
  detail?: string;
  slotKey?: string;
  sends: GroupPostSend[];
}

export interface GroupPostPreview {
  groupChatId: Id<"groupChats">;
  subject: string;
  text: string;
}

/** Retorno de `api.groupPosts.sendNow` (prévia e envio real). */
export interface SendNowResult {
  dryRun: boolean;
  text: string;
  previews: GroupPostPreview[];
  delivered?: number;
  sends?: { groupChatId: Id<"groupChats">; messageId?: Id<"messages">; error?: string }[];
}

/** Linha de `api.groupChats.listChannelGroupSettings`. */
export interface ChannelGroupSettings {
  channelConfigId: Id<"channelConfigs">;
  displayName: string;
  status: "active" | "disabled" | "error";
  bridgeSessionState: string | null;
  groupsEnabled: boolean;
  groupsAckAt: number | null;
  lastSyncAt: number | null;
}
