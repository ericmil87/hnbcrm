/**
 * Test-only builder of a tiny, SYNTHETIC Ogg/Opus byte stream (no real audio):
 * OpusHead, OpusTags, then one page per audio packet with the given sizes. The
 * packet payloads are zeros and the page CRC is left at 0, which is enough for
 * `readOggOpus` (it reads structure, not audio). Lives outside `*.test.ts` so
 * two test files can share it; nothing in production imports it.
 */
const SAMPLES_PER_PACKET = 960; // 20 ms at 48 kHz

function page(packet: Uint8Array, granule: number, sequence: number): Uint8Array {
  const lacing: number[] = [];
  let left = packet.length;
  while (left >= 255) {
    lacing.push(255);
    left -= 255;
  }
  lacing.push(left);
  const out = new Uint8Array(27 + lacing.length + packet.length);
  out.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  const view = new DataView(out.buffer);
  view.setUint32(6, granule >>> 0, true);
  view.setUint32(10, Math.floor(granule / 4294967296), true);
  view.setUint32(14, 1, true); // serial
  view.setUint32(18, sequence, true);
  out[26] = lacing.length;
  out.set(lacing, 27);
  out.set(packet, 27 + lacing.length);
  return out;
}

export function buildSyntheticOggOpus(packetSizes: readonly number[], preSkip = 312): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  head[8] = 1; // version
  head[9] = 1; // channels
  head[10] = preSkip & 0xff;
  head[11] = preSkip >> 8;
  const tags = new Uint8Array(16);
  tags.set(new TextEncoder().encode("OpusTags"), 0);
  const pages = [page(head, 0, 0), page(tags, 0, 1)];
  packetSizes.forEach((size, i) => {
    pages.push(page(new Uint8Array(size), preSkip + (i + 1) * SAMPLES_PER_PACKET, i + 2));
  });
  const total = pages.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of pages) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** 2 s: 50 loud packets (large) then 50 quiet ones (small). */
export function syntheticVoiceNote(): Uint8Array {
  return buildSyntheticOggOpus([...new Array<number>(50).fill(120), ...new Array<number>(50).fill(6)]);
}
