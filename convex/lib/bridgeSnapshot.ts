/**
 * Snapshot da `channelConfigs` que viaja junto com o webhook do bridge
 * (perf Convex I/O, onda 2).
 *
 * O httpAction `bridge.webhookReceive` já lê a config inteira (pela instância)
 * para validar provider/status/HMAC. Antes, cada etapa agendada relia o MESMO
 * documento: `internalIngestBridgeMessage`/`internalIngestGroupMessage` por
 * `internalGetConfig` e `whatsapp.internalRouteInbound` por `ctx.db.get` — três
 * leituras do doc inteiro (com os campos cifrados e de saúde) por mensagem.
 * Agora a config é lida UMA vez e as etapas recebem só o que usam.
 *
 * Campos: levantados lendo `internalIngestBridgeMessage`,
 * `internalIngestGroupMessage`, `downloadInboundMedia` →
 * `lib/bridgeMediaDownload.ts` (`organizationId`, `bridgeBaseUrl`,
 * `bridgeTokenEncrypted`), `shouldAutoDownloadGroupMedia` (`bridgeGroupMedia`,
 * `bridgeLid`, `bridgePhone`), `internalLearnBridgeIdentity` (gatilho por
 * `bridgeLid`/`bridgePhone` vazios), `internalRouteInbound` e
 * `findAttendantForChannel` (`_id`, `organizationId`, `status`, `provider`).
 * `bridgeTokenEncrypted` é o CIPHERTEXT — vai em args de função INTERNA, nunca
 * para cliente; o token decifrado nunca entra no snapshot.
 *
 * RISCO ACEITO: o snapshot pode ficar velho entre o webhook e a action
 * agendada (milissegundos em regime normal). Um canal desativado nesse
 * intervalo ainda ingere a mensagem que já estava em voo — a mesma que o
 * gateway já tinha entregue e o webhook já tinha aceitado. Nesse caminho não há
 * envio ao cliente, só gravação, então não vale uma releitura por mensagem para
 * fechar a janela. (O atendente IA re-checa a elegibilidade no claim/commit.)
 */
import { Infer, v } from "convex/values";
import { groupMediaModeValidator } from "../schema";

const configStatusValidator = v.union(
  v.literal("active"),
  v.literal("disabled"),
  v.literal("error")
);

export const bridgeConfigSnapshotValidator = v.object({
  _id: v.id("channelConfigs"),
  organizationId: v.id("organizations"),
  status: configStatusValidator,
  /** Já resolvido por `configProvider` (ausente = meta). */
  provider: v.union(v.literal("meta"), v.literal("bridge")),
  bridgeBaseUrl: v.optional(v.string()),
  bridgeTokenEncrypted: v.optional(v.string()),
  bridgeGroupsEnabled: v.optional(v.boolean()),
  bridgeLid: v.optional(v.string()),
  bridgePhone: v.optional(v.string()),
  bridgeGroupMedia: v.optional(
    v.object({
      image: v.optional(groupMediaModeValidator),
      audio: v.optional(groupMediaModeValidator),
      video: v.optional(groupMediaModeValidator),
      document: v.optional(groupMediaModeValidator),
    })
  ),
});

export type BridgeConfigSnapshot = Infer<typeof bridgeConfigSnapshotValidator>;

/**
 * Só o que `internalRouteInbound` precisa (Meta e bridge): roteamento de
 * contato/lead + atendente do canal.
 */
export const inboundRouteChannelValidator = v.object({
  _id: v.id("channelConfigs"),
  organizationId: v.id("organizations"),
  status: configStatusValidator,
  provider: v.union(v.literal("meta"), v.literal("bridge")),
});

export type InboundRouteChannel = Infer<typeof inboundRouteChannelValidator>;

type ConfigLike = {
  _id: BridgeConfigSnapshot["_id"];
  organizationId: BridgeConfigSnapshot["organizationId"];
  status: BridgeConfigSnapshot["status"];
  provider?: "meta" | "bridge" | null;
  bridgeBaseUrl?: string;
  bridgeTokenEncrypted?: string;
  bridgeGroupsEnabled?: boolean;
  bridgeLid?: string;
  bridgePhone?: string;
  bridgeGroupMedia?: BridgeConfigSnapshot["bridgeGroupMedia"];
};

/** Monta o snapshot a partir do doc já lido — allowlist explícita de campos. */
export function buildBridgeConfigSnapshot(config: ConfigLike): BridgeConfigSnapshot {
  const snapshot: BridgeConfigSnapshot = {
    _id: config._id,
    organizationId: config.organizationId,
    status: config.status,
    provider: config.provider === "bridge" ? "bridge" : "meta",
  };
  if (config.bridgeBaseUrl !== undefined) snapshot.bridgeBaseUrl = config.bridgeBaseUrl;
  if (config.bridgeTokenEncrypted !== undefined) {
    snapshot.bridgeTokenEncrypted = config.bridgeTokenEncrypted;
  }
  if (config.bridgeGroupsEnabled !== undefined) {
    snapshot.bridgeGroupsEnabled = config.bridgeGroupsEnabled;
  }
  if (config.bridgeLid !== undefined) snapshot.bridgeLid = config.bridgeLid;
  if (config.bridgePhone !== undefined) snapshot.bridgePhone = config.bridgePhone;
  if (config.bridgeGroupMedia !== undefined) snapshot.bridgeGroupMedia = config.bridgeGroupMedia;
  return snapshot;
}

/** Recorte de roteamento (subconjunto do snapshot; serve também para Meta). */
export function toInboundRouteChannel(config: ConfigLike): InboundRouteChannel {
  return {
    _id: config._id,
    organizationId: config.organizationId,
    status: config.status,
    provider: config.provider === "bridge" ? "bridge" : "meta",
  };
}
