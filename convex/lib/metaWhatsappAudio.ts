// Audio on the official WhatsApp Cloud API (Meta) path.
//
// The Cloud API fetches the attachment from our storage link and only accepts
// audio/aac, audio/amr, audio/mpeg, audio/mp4 and audio/ogg (opus). Safari's
// mp4/AAC voice note goes straight through; Chrome/Edge record webm, which Meta
// refuses. There is no transcoding on this path (it would need a second stored
// blob + file row + cleanup), so an unsupported type fails BEFORE the send with
// a clear reason instead of a Graph error after the fact.

export const META_WHATSAPP_AUDIO_MIME_TYPES: readonly string[] = [
  "audio/aac",
  "audio/amr",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
];

export type MetaAudioCheck = { ok: true } | { ok: false; detail: string };

/** Pre-send check for an audio attachment on the Meta WhatsApp path. */
export function checkMetaWhatsappAudio(mimeType: string): MetaAudioCheck {
  const base = (mimeType || "").split(";")[0].trim().toLowerCase();
  if (META_WHATSAPP_AUDIO_MIME_TYPES.includes(base)) return { ok: true };
  if (base === "audio/webm") {
    return {
      ok: false,
      detail:
        "A API oficial do WhatsApp não aceita áudio no formato webm (gravado no Chrome ou Edge). Grave a nota de voz pelo Safari/iPhone ou envie por um número conectado por QR code.",
    };
  }
  return {
    ok: false,
    detail: `A API oficial do WhatsApp não aceita áudio neste formato (${base || "desconhecido"}). Use mp3, m4a ou ogg.`,
  };
}
