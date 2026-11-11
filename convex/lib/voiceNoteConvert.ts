/**
 * PORTA ÚNICA do conversor de nota de voz (`/convert?target=ogg-opus` do serviço
 * Whisper na VPS, fora do repo). Usada pelo dispatch do bridge (gravação do
 * navegador em webm/mp4) e pela resposta em áudio do atendente (WAV embrulhado
 * do PCM do TTS, `convex/voiceReplyNode.ts`). Guard: `voiceNoteConvertPort.test.ts`.
 *
 * O serviço roda `ffmpeg -i <arquivo>` (o contêiner é detectado pelo conteúdo,
 * não pelo nome) e devolve ogg/opus mono 16 kHz 32 kbps. WAV (RIFF) é detectado
 * pelo ffmpeg; o código que roda na VPS não foi conferido a partir deste
 * repositório (a cópia local do `main.py` é gitignored): se o serviço recusar,
 * devolve `null` e quem chama decide a reserva (documento no bridge, texto no
 * atendente).
 */
import { voiceNoteConvertFilename } from "./bridgeSend";

/** Conversor configurado (as duas envs). Sem elas, nada é convertido. */
export function voiceNoteConverterConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.WHISPER_SERVICE_URL && env.WHISPER_SERVICE_TOKEN);
}

/**
 * Converte para `audio/ogg; codecs=opus` (formato do voice note do WhatsApp).
 * Devolve os bytes, ou `null` quando o serviço não está configurado, demora
 * mais que `timeoutMs` (se informado) ou falha. Nunca lança.
 */
export async function convertVoiceNoteToOggOpus(
  bytes: Uint8Array,
  mimeType: string,
  opts?: { timeoutMs?: number }
): Promise<Uint8Array | null> {
  const serviceUrl = process.env.WHISPER_SERVICE_URL;
  const serviceToken = process.env.WHISPER_SERVICE_TOKEN;
  if (!serviceUrl || !serviceToken) return null;
  try {
    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes as BlobPart], { type: mimeType || "application/octet-stream" }),
      voiceNoteConvertFilename(mimeType)
    );
    const response = await fetch(`${serviceUrl.replace(/\/$/, "")}/convert?target=ogg-opus`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceToken}` },
      body: form,
      ...(opts?.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) return null;
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}
