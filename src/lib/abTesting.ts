// A/B Testing client-side utilities: MurmurHash3, visitorId, deterministic variant selection

const VISITOR_ID_KEY = "hnbcrm_visitor_id";

// MurmurHash3 (32-bit) — deterministic hashing for consistent variant assignment
function murmurHash3(key: string, seed: number = 0): number {
  let h = seed | 0;
  const len = key.length;
  const nblocks = len >> 2;

  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;

  for (let i = 0; i < nblocks; i++) {
    let k =
      (key.charCodeAt(i * 4) & 0xff) |
      ((key.charCodeAt(i * 4 + 1) & 0xff) << 8) |
      ((key.charCodeAt(i * 4 + 2) & 0xff) << 16) |
      ((key.charCodeAt(i * 4 + 3) & 0xff) << 24);

    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);

    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = Math.imul(h, 5) + 0xe6546b64;
  }

  let k1 = 0;
  const tail = nblocks * 4;

  // Cauda de 1-3 bytes. Era um switch com fallthrough deliberado; virou cascata
  // de ifs porque o TypeScript não reconhece o comentário "// fall through" e
  // marcava o caso como erro. A semântica (e o hash) são idênticos.
  const rem = len & 3;
  if (rem >= 3) k1 ^= (key.charCodeAt(tail + 2) & 0xff) << 16;
  if (rem >= 2) k1 ^= (key.charCodeAt(tail + 1) & 0xff) << 8;
  if (rem >= 1) {
    k1 ^= key.charCodeAt(tail) & 0xff;
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h ^= k1;
  }

  h ^= len;
  // fmix32
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;

  return h >>> 0;
}

/**
 * Get or create a persistent visitor ID for A/B testing.
 */
export function getVisitorId(): string {
  try {
    const existing = localStorage.getItem(VISITOR_ID_KEY);
    if (existing) return existing;

    const id = crypto.randomUUID();
    localStorage.setItem(VISITOR_ID_KEY, id);
    return id;
  } catch {
    // localStorage unavailable — use ephemeral ID
    return crypto.randomUUID();
  }
}

export interface ExperimentVariant {
  _id: string;
  variantKey: string;
  formId: string;
  slug: string;
  trafficWeight: number;
  isControl: boolean;
}

/**
 * Deterministically select a variant based on experimentId + visitorId.
 * Hash-based bucketing into 0-10000 range mapped to variant by cumulative weight.
 */
export function selectVariant(
  experimentId: string,
  visitorId: string,
  variants: ExperimentVariant[]
): ExperimentVariant {
  const hash = murmurHash3(`${experimentId}:${visitorId}`);
  const bucket = hash % 10000;

  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.trafficWeight;
    if (bucket < cumulative) {
      return variant;
    }
  }

  // Fallback to last variant (shouldn't happen if weights sum to 10000)
  return variants[variants.length - 1];
}
