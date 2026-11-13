/**
 * Aceite da IA no WhatsApp por QR code (`aiConfig.bridgeAiAck`): regras puras
 * do que a tela mostra. O aceite continua obrigatório, auditado e sempre por
 * clique (`aiSettings.setBridgeAiAck` / `activateOneFlow`); aqui só se decide
 * QUANDO pedir e COMO mostrar o estado, para a IA nunca ficar muda sem aviso.
 */

/** Campos de `aiSettings.getAiStatus` que a regra usa. */
export interface BridgeAiStatusInput {
  active: boolean;
  attendantEnabled: boolean;
  hasAttendant: boolean;
  hasConnectedBridgeChannel?: boolean;
  bridgeAiAckDone: boolean;
}

/**
 * - `on`: aceite dado, a IA responde nos números por QR code;
 * - `off`: sem aceite, e nada está calado por isso (sem número por QR code
 *   conectado ou sem IA/atendente ligados);
 * - `muted`: número por QR code CONECTADO + IA e atendente ligados + sem
 *   aceite: a IA está muda nesse número. Só aqui há destaque de alerta.
 */
export type BridgeAiState = "on" | "off" | "muted";

export function bridgeAiState(s: BridgeAiStatusInput): BridgeAiState {
  if (s.bridgeAiAckDone) return "on";
  if (s.active && s.attendantEnabled && s.hasAttendant && s.hasConnectedBridgeChannel === true) return "muted";
  return "off";
}

export const BRIDGE_AI_STATE_TEXT: Record<BridgeAiState, string> = {
  on: "Ligado: a IA responde nos números por QR code.",
  off: "Desligado: a IA só responde no WhatsApp oficial (Meta).",
  muted: "Desligado: a IA está ligada, mas não responde no seu número por QR code até você aceitar o risco.",
};

/** Título e texto do aviso que aparece onde a pessoa estiver quando a IA está muda. */
export const BRIDGE_AI_MUTED_NOTICE = {
  title: "A IA não está respondendo no seu número por QR code",
  body: "Para a IA responder num número conectado por QR code, é preciso aceitar o risco de banimento desse tipo de conexão.",
  action: "Liberar a IA neste número",
} as const;

/**
 * Ao conectar um número por QR code: o aceite da IA entra na MESMA confirmação
 * do aviso de banimento quando a IA da org já está ligada e o aceite ainda não
 * foi dado. Sem IA ligada, o aceite é pedido quando ela for ligada.
 */
export function asksAiAckOnQrConnect(s: Pick<BridgeAiStatusInput, "active" | "attendantEnabled" | "bridgeAiAckDone">): boolean {
  return s.active && s.attendantEnabled && !s.bridgeAiAckDone;
}

/** Frase a mais no aviso de risco do QR code quando o aceite da IA vem junto. */
export const QR_CONNECT_AI_SENTENCE = "A IA da sua empresa também vai responder neste número.";
