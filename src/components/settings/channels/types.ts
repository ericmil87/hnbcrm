import type { Id } from "../../../../convex/_generated/dataModel";
import type { BridgeSessionState, ChannelStatus } from "@/lib/channelBadges";

export type Provider = "meta" | "bridge";
export type { BridgeSessionState };

// Masked shape returned by getChannelConfigs — Meta fields are null on bridge
// configs and bridge fields are null on Meta configs (defensive rendering below).
export type ChannelConfig = {
  _id: Id<"channelConfigs">;
  channel: "whatsapp";
  provider: Provider;
  displayName: string;
  // Meta
  phoneNumberId: string | null;
  wabaId: string | null;
  displayPhoneNumber: string | null;
  verifyToken: string | null;
  appSecretMasked: string | null;
  accessTokenMasked: string | null;
  hasToken: boolean;
  // Bridge
  bridgeBaseUrl: string | null;
  bridgeInstanceId: string | null;
  bridgeTokenMasked: string | null;
  hasBridgeToken: boolean;
  bridgeSessionState: BridgeSessionState | null;
  autoTranscribeAudio: boolean;
  // Bridge: aparelho invisível (notificações do WhatsApp seguem no celular). Servidor assume true se ausente.
  bridgePhoneNotifications?: boolean;
  // Histórico do aparelho (bridge). Números já normalizados pelo servidor.
  bridgeHistoryEnabled: boolean;
  bridgeHistoryLimit: number;
  bridgeHistoryDays: number;
  bridgeHistoryLastSyncAt: number | null;
  bridgeHistoryLastResult: string | null;
  status: ChannelStatus;
  lastHealthCheckAt: number | null;
  healthDetail: string | null;
  createdAt: number;
  updatedAt: number;
};

export type CreateChannelConfigFn = (args: {
  organizationId: Id<"organizations">;
  channel: "whatsapp";
  provider?: Provider;
  displayName: string;
  phoneNumberId?: string;
  wabaId?: string;
  verifyToken?: string;
  appSecret?: string;
  accessToken?: string;
  bridgeBaseUrl?: string;
  bridgeInstanceId?: string;
  bridgeToken?: string;
}) => Promise<Id<"channelConfigs">>;

export type UpdateChannelConfigFn = (args: {
  configId: Id<"channelConfigs">;
  displayName?: string;
  phoneNumberId?: string;
  wabaId?: string;
  verifyToken?: string;
  appSecret?: string;
  accessToken?: string;
  bridgeBaseUrl?: string;
  bridgeInstanceId?: string;
  bridgeToken?: string;
  autoTranscribeAudio?: boolean;
}) => Promise<null>;

export type ProvisionBridgeFn = (args: {
  organizationId: Id<"organizations">;
  displayName: string;
  bridgeBaseUrl?: string;
  adminToken?: string;
  webhookUrl: string;
  useManagedGateway?: boolean;
}) => Promise<Id<"channelConfigs">>;
