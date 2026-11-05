// API de conexão por código usada pelo passo "Conectar WhatsApp" da configuração
// inicial. A lógica mora em `channelConnect.ts` (compartilhada com Configurações);
// este arquivo só a expõe com os nomes que o wizard importa.
export {
  CODE_POLL_MAX_MS,
  CODE_REGENERATE_AFTER_MS,
  CODE_VALID_MS,
  CONNECT_NARROW_QUERY,
  PAIRING_POLL_INTERVAL_MS,
  canRequestNewCode,
  codePollExpired,
  codeSecondsLeft,
  defaultConnectMode,
  formatCountdown,
  formatLinkingCode,
  friendlyPairingError,
  type ConnectMode,
} from "./channelConnect";
