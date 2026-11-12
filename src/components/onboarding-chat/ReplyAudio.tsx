import { useState } from "react";
import type { OnboardingReplyAudio } from "@/lib/onboardingStream";

export interface ReplyAudioProps {
  audio: OnboardingReplyAudio;
}

/**
 * Resposta falada do Copiloto (WAV do storage). Se a URL falhar (404 depois da
 * limpeza de 7 dias, rede), o player some e fica só o texto da bolha.
 */
export function ReplyAudio({ audio }: ReplyAudioProps) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <audio
      controls
      preload="none"
      src={audio.url}
      onError={() => setFailed(true)}
      aria-label="Resposta em áudio do Copiloto"
      className="mt-1 h-11 w-full max-w-xs"
    />
  );
}
