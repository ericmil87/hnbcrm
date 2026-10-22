/** Janela de serviço por canal (Meta Messaging, plano §8). Pura. */

export type ServiceWindowKind = "template" | "wait" | null;

export interface ServiceWindowInfo {
  text: string;
  /** Janela já fechada (vira aviso em tom de alerta). */
  closed: boolean;
}

const HOUR = 3_600_000;
const MINUTE = 60_000;

/**
 * Banner da janela. `template` = WhatsApp Cloud API; `wait` = Instagram/Messenger
 * (só o cliente reabre). `null` = sem janela, sem banner.
 */
export function getServiceWindowInfo(
  kind: ServiceWindowKind | undefined,
  expiresAt: number | null | undefined,
  now: number
): ServiceWindowInfo | null {
  if (!kind) return null;
  if (!expiresAt || expiresAt <= now) {
    return {
      text:
        kind === "wait"
          ? "Janela fechada — aguarde o cliente escrever de novo"
          : "Janela fechada — requer template",
      closed: true,
    };
  }
  const remainingMs = expiresAt - now;
  if (kind === "template") {
    const minutes = Math.max(1, Math.round(remainingMs / MINUTE));
    return {
      text:
        minutes < 60
          ? `Janela fecha em ${minutes}min`
          : `Janela fecha em ${Math.round(minutes / 60)}h`,
      closed: false,
    };
  }
  if (remainingMs > 24 * HOUR) {
    return { text: "Janela aberta — até 7 dias", closed: false };
  }
  const totalMinutes = Math.max(1, Math.round(remainingMs / MINUTE));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const text =
    h === 0 ? `${m}min` : m === 0 ? `${h}h` : `${h}h ${m}min`;
  return { text: `Janela fecha em ${text}`, closed: false };
}

/** Composer bloqueado: só em `wait` com a janela fechada. Nota interna segue livre. */
export function isComposerBlockedByWindow(
  kind: ServiceWindowKind | undefined,
  expiresAt: number | null | undefined,
  now: number
): boolean {
  return kind === "wait" && (!expiresAt || expiresAt <= now);
}

/** Rótulo de mensagem enviada fora do CRM (`metadata.via === "device"`). */
export function deviceViaLabel(viaApp: unknown): string {
  if (viaApp === "page_inbox") return "pelo Business Suite";
  if (viaApp === "other") return "pelo app";
  return "fora do CRM";
}

export const STANDBY_BANNER_TEXT =
  "Outro app (ex.: Caixa de entrada do Meta Business Suite) controla esta conversa; o HNBCRM só recebe. Defina o HNBCRM como app padrão em Configurações da Página > Mensagens avançadas.";
