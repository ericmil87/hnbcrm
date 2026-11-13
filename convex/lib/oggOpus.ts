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

// ---------------------------------------------------------------------------
// Timeline repair
// ---------------------------------------------------------------------------

/** Samples (48 kHz) in one Opus packet, from its TOC byte (RFC 6716 §3.1). 0 when unreadable. */
export function opusPacketSamples(toc: number, secondByte: number | undefined): number {
  const config = toc >> 3;
  let frameSamples: number;
  if (config < 12) frameSamples = [480, 960, 1920, 2880][config & 3]; // SILK 10/20/40/60 ms
  else if (config < 16) frameSamples = [480, 960][config & 1]; // hybrid 10/20 ms
  else frameSamples = [120, 240, 480, 960][config & 3]; // CELT 2.5/5/10/20 ms
  const code = toc & 3;
  const frames = code === 0 ? 1 : code === 3 ? (secondByte ?? 0) & 0x3f : 2;
  return frames * frameSamples;
}

let oggCrcTable: Uint32Array | null = null;
/** Ogg page checksum: CRC-32, polynomial 0x04c11db7, no reflection, initial value 0. */
function oggCrc(bytes: Uint8Array, from: number, to: number): number {
  if (!oggCrcTable) {
    oggCrcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
      oggCrcTable[i] = r >>> 0;
    }
  }
  let crc = 0;
  for (let i = from; i < to; i++) crc = ((crc << 8) ^ oggCrcTable[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return crc;
}

function writeUint32LE(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >>> 8) & 0xff;
  bytes[at + 2] = (value >>> 16) & 0xff;
  bytes[at + 3] = (value >>> 24) & 0xff;
}

/**
 * Rewrites the granule position of every audio page as the running count of
 * samples in the packets that END on it, and fixes the page checksums.
 *
 * Why: RFC 7845 §4.5 makes a stream invalid when the first audio page's granule
 * is smaller than the samples it holds (unless it is also the last page). The
 * `/convert` service produces exactly that for a browser recording: its ffmpeg
 * carries the webm timestamps over, and the first page comes out 312 samples
 * (the pre-skip) short, with small drifts on later pages. ffmpeg plays such a
 * file; WhatsApp shows the voice note and never plays it (prod, 13/11/2026,
 * phone and web). The attendant's voice reply, converted from WAV by the same
 * service, has exact granules and plays.
 *
 * Returns the same array when nothing needs to change, a repaired copy
 * otherwise, and `null` when the bytes are not a readable Ogg/Opus stream
 * (the caller then sends the original). Never throws.
 */
export function repairOggOpusTimeline(bytes: Uint8Array): Uint8Array | null {
  try {
    type Page = { at: number; end: number; granuleKnown: boolean; granule: number; expected: number | null };
    const pages: Page[] = [];
    let at = 0;
    let packetIndex = 0;
    let pending = 0;
    let packetToc = -1;
    let packetSecond: number | undefined;
    let samples = 0;
    let sawHead = false;

    while (at + 27 <= bytes.length) {
      if (!isOggPage(bytes, at)) return null;
      const low = readUint32LE(bytes, at + 6);
      const high = readUint32LE(bytes, at + 10);
      const segments = bytes[at + 26];
      const tableAt = at + 27;
      const dataAt = tableAt + segments;
      if (dataAt > bytes.length) return null;
      let offset = dataAt;
      let completedAudio = 0;
      for (let s = 0; s < segments; s++) {
        const lacing = bytes[tableAt + s];
        if (pending === 0 && lacing > 0) {
          packetToc = bytes[offset];
          packetSecond = lacing > 1 ? bytes[offset + 1] : undefined;
        }
        pending += lacing;
        offset += lacing;
        if (lacing === 255) continue;
        if (packetIndex === 0) {
          if (!startsWith(bytes, offset - pending, "OpusHead")) return null;
          sawHead = true;
        } else if (packetIndex > 1 && pending > 0) {
          const packetSamples = opusPacketSamples(packetToc, packetSecond);
          if (packetSamples <= 0) return null;
          samples += packetSamples;
          completedAudio++;
        }
        packetIndex++;
        pending = 0;
        packetToc = -1;
      }
      if (offset > bytes.length) return null;
      const noPacket = low === 0xffffffff && high === 0xffffffff;
      pages.push({
        at,
        end: offset,
        granuleKnown: !noPacket,
        granule: high * 4294967296 + low,
        expected: completedAudio > 0 ? samples : null,
      });
      at = offset;
    }
    if (!sawHead || samples === 0 || at !== bytes.length) return null;

    const wrong = pages.filter((p) => p.expected !== null && (!p.granuleKnown || p.granule !== p.expected));
    if (wrong.length === 0) return bytes;
    // Only the last page may legitimately differ (end trimming): if it is the
    // single mismatch and its granule is not ahead of the samples, leave the file alone.
    const last = pages[pages.length - 1];
    if (wrong.length === 1 && wrong[0] === last && last.granuleKnown && last.granule < (last.expected ?? 0)) {
      const previous = pages.length > 1 ? pages[pages.length - 2] : null;
      if (!previous || previous.expected === null || last.granule > previous.expected) return bytes;
    }

    const out = bytes.slice();
    const lastGranuleTrim =
      last.expected !== null && last.granuleKnown && last.granule < last.expected
        ? Math.min(last.expected - last.granule, 2880) // keep a plausible end trim (at most one long packet)
        : 0;
    for (const page of pages) {
      if (page.expected === null) continue;
      const granule = page === last ? page.expected - lastGranuleTrim : page.expected;
      writeUint32LE(out, page.at + 6, granule >>> 0);
      writeUint32LE(out, page.at + 10, Math.floor(granule / 4294967296));
      writeUint32LE(out, page.at + 22, 0);
      writeUint32LE(out, page.at + 22, oggCrc(out, page.at, page.end));
    }
    return out;
  } catch {
    return null;
  }
}
