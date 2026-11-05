import type { Id } from "../../../../convex/_generated/dataModel";
import { MetaForm } from "./MetaForm";
import { QrCodeConnectForm } from "./QrCodeConnectForm";
import type {
  ChannelConfig,
  CreateChannelConfigFn,
  CreateManagedChannelFn,
  UpdateChannelConfigFn,
} from "./types";

/** Editar um número que já existe (a conexão de número novo é do `ChannelConnectCard`). */
export function ChannelEditForm({
  organizationId,
  config,
  onClose,
  createChannelConfig,
  updateChannelConfig,
  createManagedChannel,
}: {
  organizationId: Id<"organizations">;
  config: ChannelConfig;
  onClose: () => void;
  createChannelConfig: CreateChannelConfigFn;
  updateChannelConfig: UpdateChannelConfigFn;
  createManagedChannel: CreateManagedChannelFn;
}) {
  return config.provider === "meta" ? (
    <MetaForm
      organizationId={organizationId}
      config={config}
      onClose={onClose}
      createChannelConfig={createChannelConfig}
      updateChannelConfig={updateChannelConfig}
    />
  ) : (
    <QrCodeConnectForm
      organizationId={organizationId}
      config={config}
      defaults={{ managedAvailable: false }}
      onClose={onClose}
      createChannelConfig={createChannelConfig}
      updateChannelConfig={updateChannelConfig}
      createManagedChannel={createManagedChannel}
    />
  );
}
