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

export type CreateManagedChannelFn = (args: {
  organizationId: Id<"organizations">;
  displayName: string;
  bridgeBaseUrl?: string;
  adminToken?: string;
  useManagedGateway?: boolean;
}) => Promise<Id<"channelConfigs">>;

/** Resultado de `startBridgePairing` / `pollBridgePairing`. O QR e o código nunca são guardados nem registrados. */
export type PairingResult = {
  state: "qr" | "code" | "connected" | "error";
  qrCode?: string;
  linkingCode?: string;
  displayPhoneNumber?: string;
  displacedFrom?: string[];
  error?: string;
  attemptsLeft?: number;
};

export type StartPairingFn = (args: {
  configId: Id<"channelConfigs">;
  mode: "qr" | "code";
  phone?: string;
}) => Promise<PairingResult>;

export type PollPairingFn = (args: {
  configId: Id<"channelConfigs">;
  mode: "qr" | "code";
}) => Promise<PairingResult>;

export interface ChannelConnectActions {
  createChannelConfig: CreateChannelConfigFn;
  updateChannelConfig: UpdateChannelConfigFn;
  createManagedChannel: CreateManagedChannelFn;
  startPairing: StartPairingFn;
  pollPairing: PollPairingFn;
  /** Chamado uma vez quando o número conecta (grava o estado para o card atualizar). */
  markConnected?: (configId: Id<"channelConfigs">) => void;
}
