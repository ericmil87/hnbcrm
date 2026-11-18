// Regras puras do teste da resposta em áudio (amostra de voz e simulador com voz).
// Os rótulos dos motivos vêm do servidor (`convex/lib/voicePreview.ts`, fonte única).
import type { SimulatedVoice } from "../../convex/lib/voicePreview";

export type { SimulatedVoice };

export type SimTransportValue = "meta" | "bridge" | "instagram" | "messenger";

/**
 * Canal mandado ao simulador. Com voz ligada, o padrão é o WhatsApp por QR code
 * (o único canal que responde em áudio hoje); Instagram/Messenger escolhidos à mão
 * seguem, para mostrar que lá a resposta vai em texto.
 */
export function simulatorTransportArg(input: {
  voiceOn: boolean;
  metaEnabled: boolean;
  transport: SimTransportValue;
}): SimTransportValue | undefined {
  if (input.voiceOn) return input.metaEnabled ? input.transport : "bridge";
  return input.metaEnabled && input.transport !== "meta" ? input.transport : undefined;
}

export interface SimulatedVoiceView {
  tone: "audio" | "text" | "error";
  title: string;
  detail: string | null;
  /** Aviso extra (voz desligada na organização). */
  warning: string | null;
}

const OFF_WARNING = "A resposta em áudio está desligada: em produção esta resposta iria em texto.";

/** Como a bolha do simulador apresenta o resultado da voz. */
export function simulatedVoiceView(voice: SimulatedVoice): SimulatedVoiceView {
  if (voice.mode === "audio") {
    const seconds = Math.max(1, Math.round(voice.durationSec));
    return {
      tone: "audio",
      title: `Resposta em áudio · voz ${voice.voice} · ${seconds} s`,
      detail: voice.noticeIncluded ? "Começa com o aviso de voz sintética (só no primeiro áudio de cada conversa)." : null,
      warning: voice.enabledInOrg ? null : OFF_WARNING,
    };
  }
  if (voice.rule) {
    return { tone: "text", title: "Esta resposta iria em texto", detail: voice.message, warning: null };
  }
  return { tone: "error", title: "Não foi possível gerar o áudio de teste", detail: voice.message, warning: null };
}

/** Aviso digitado (salvo ou não) → o que a amostra fala; vazio = só a saudação. */
export function previewNotice(draft: string): string | undefined {
  const normalized = draft.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}
