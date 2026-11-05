import { useAction, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { QrConnectDefaults } from "./QrCodeConnectForm";
import type { ChannelConnectActions, CreateManagedChannelFn } from "./types";

/** Cria o número no servidor de conexão (o do HNBCRM ou o próprio). O servidor monta o webhook. */
export function useCreateManagedChannel(): CreateManagedChannelFn {
  return useAction(api.channelConfigs.provisionBridgeChannel);
}

/** Há servidor gerenciado do HNBCRM? `undefined` enquanto carrega; `skip` para número que já existe. */
export function useQrConnectDefaults(
  organizationId: Id<"organizations">,
  skip: boolean
): QrConnectDefaults | undefined {
  return useQuery(api.channelConfigs.getBridgeProvisionDefaults, skip ? "skip" : { organizationId });
}

/** Chamadas do `ChannelConnectCard` ligadas ao Convex. */
export function useChannelConnectActions(): ChannelConnectActions {
  const createChannelConfig = useAction(api.channelConfigs.createChannelConfig);
  const updateChannelConfig = useAction(api.channelConfigs.updateChannelConfig);
  const createManagedChannel = useCreateManagedChannel();
  const startPairing = useAction(api.channelConfigs.startBridgePairing);
  const pollPairing = useAction(api.channelConfigs.pollBridgePairing);
  const checkChannelHealth = useAction(api.channelConfigs.checkChannelHealth);
  return {
    createChannelConfig,
    updateChannelConfig,
    createManagedChannel,
    startPairing,
    pollPairing,
    markConnected: (id) => void checkChannelHealth({ configId: id }).catch(() => undefined),
  };
}
