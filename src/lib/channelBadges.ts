export type BridgeSessionState =
  | "connected"
  | "connecting"
  | "qr"
  | "disconnected"
  | "banned"
  | "logged_out"
  | "temporarily_banned"
  | "outdated";

export type ChannelStatus = "active" | "disabled" | "error";

export type BadgeVariant = "success" | "warning" | "info" | "error";

export function statusBadgeVariant(status: ChannelStatus) {
  if (status === "active") return "success" as const;
  if (status === "error") return "error" as const;
  return "default" as const;
}

export function statusLabel(status: ChannelStatus) {
  if (status === "active") return "Ativo";
  if (status === "error") return "Erro";
  return "Desativado";
}

// Fine-grained pairing badge for bridge configs (from the last health/QR check).
export function bridgeStateBadge(state: BridgeSessionState): {
  variant: BadgeVariant;
  label: string;
} {
  switch (state) {
    case "connected":
      return { variant: "success", label: "Conectado" };
    case "connecting":
      return { variant: "warning", label: "Reconectando" };
    case "qr":
      return { variant: "info", label: "Aguardando QR" };
    case "banned":
      return { variant: "error", label: "Banido" };
    case "temporarily_banned":
      return { variant: "error", label: "Banimento temporário" };
    case "outdated":
      return { variant: "error", label: "Conexão desatualizada" };
    case "logged_out":
      return { variant: "error", label: "Deslogado" };
    case "disconnected":
    default:
      return { variant: "error", label: "Deslogado" };
  }
}
