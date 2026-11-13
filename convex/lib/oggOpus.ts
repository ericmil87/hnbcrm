/**
 * Minimal Ogg/Opus reader (pure): duration and a 64-bar loudness sketch of a
 * voice note, without decoding audio.
 *
 * Why it exists: a human voice note went to the gateway with no `Seconds` and
 * no `Waveform` (only the attendant's voice reply measured them, from the TTS
 * PCM). WhatsApp showed those notes with no duration and a download arrow that
 * did nothing (prod, 13/11/2026), while the attendant's notes, identical in
 * every other field, played. So every voice note now carries both.
 *
 * - Duration = (granule position of the last page - pre-skip) / 48000. Opus
 *   granules always count 48 kHz samples, whatever the input rate.
 * - Waveform = average packet size per bucket, normalized to 0-100. With VBR
 *   (what the `/convert` service produces) a quiet frame is a small packet, so
 *   packet size follows loudness closely enough for the bars. It is a sketch,
 *   not a measurement of amplitude.
 */

const OPUS_SAMPLE_RATE = 48000;
export const VOICE_WAVEFORM_BARS = 64;

function readUint32LE(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

function isOggPage(bytes: Uint8Array, at: number): boolean {
  return bytes[at] === 0x4f && bytes[at + 1] === 0x67 && bytes[at + 2] === 0x67 && bytes[at + 3] === 0x53;
}

function startsWith(bytes: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

export type OggOpusInfo = {
  /** Whole seconds, at least 1 (what `metadata.voiceNote.seconds` expects). */
  seconds: number;
  /** Exact duration in seconds. */
  durationSeconds: number;
  /** 64 integers 0-100. */
  waveform: number[];
};

/** Reads an Ogg/Opus file. `null` when it is not one, is truncated, or has no audio. Never throws. */
export function readOggOpus(bytes: Uint8Array): OggOpusInfo | null {
  try {
    let at = 0;
    let preSkip = 0;
    let sawHead = false;
    let lastGranule = -1;
    let packetIndex = 0;
    let pending = 0; // bytes of a packet continued from the previous page
    const audioPacketSizes: number[] = [];

    while (at + 27 <= bytes.length) {
      if (!isOggPage(bytes, at)) return null;
      const granuleLow = readUint32LE(bytes, at + 6);
      const granuleHigh = readUint32LE(bytes, at + 10);
      const segments = bytes[at + 26];
      const tableAt = at + 27;
      const dataAt = tableAt + segments;
      if (dataAt > bytes.length) return null;

      let offset = dataAt;
      for (let s = 0; s < segments; s++) {
        const lacing = bytes[tableAt + s];
        pending += lacing;
        offset += lacing;
        if (lacing === 255) continue; // packet continues in the next segment
        const packetStart = offset - pending;
        if (packetIndex === 0) {
          // OpusHead: "OpusHead"(8) version(1) channels(1) pre-skip(2 LE) ...
          if (packetStart < dataAt || pending < 12 || !startsWith(bytes, packetStart, "OpusHead")) return null;
          preSkip = bytes[packetStart + 10] | (bytes[packetStart + 11] << 8);
          sawHead = true;
        } else if (packetIndex > 1 && pending > 0) {
          audioPacketSizes.push(pending); // packet 1 is OpusTags
        }
        packetIndex++;
        pending = 0;
      }
      if (offset > bytes.length) return null;
      // 0xFFFFFFFF_FFFFFFFF = page with no finished packet: keeps the previous granule.
      if (!(granuleLow === 0xffffffff && granuleHigh === 0xffffffff)) {
        lastGranule = granuleHigh * 4294967296 + granuleLow;
      }
      at = offset;
    }

    if (!sawHead || lastGranule <= preSkip || audioPacketSizes.length === 0) return null;
    const durationSeconds = (lastGranule - preSkip) / OPUS_SAMPLE_RATE;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
    return {
      seconds: Math.max(1, Math.round(durationSeconds)),
      durationSeconds,
      waveform: sketchWaveform(audioPacketSizes),
    };
  } catch {
    return null;
  }
}

/** Packet sizes → 64 bars 0-100 (bucket averages, stretched between the smallest and largest bucket). */
export function sketchWaveform(packetSizes: readonly number[], bars = VOICE_WAVEFORM_BARS): number[] {
  if (packetSizes.length === 0) return new Array<number>(bars).fill(0);
  const buckets: number[] = [];
  for (let b = 0; b < bars; b++) {
    const from = Math.floor((b * packetSizes.length) / bars);
    const to = Math.max(from + 1, Math.floor(((b + 1) * packetSizes.length) / bars));
    let sum = 0;
    let count = 0;
    for (let i = from; i < to && i < packetSizes.length; i++) {
      sum += packetSizes[i];
      count++;
    }
    // Fewer packets than bars: a bucket with no packet repeats the nearest one.
    buckets.push(count > 0 ? sum / count : packetSizes[Math.min(from, packetSizes.length - 1)]);
  }
  const min = Math.min(...buckets);
  const max = Math.max(...buckets);
  if (max === min) return new Array<number>(bars).fill(50);
  return buckets.map((value) => Math.round(((value - min) / (max - min)) * 100));
}
