// UTM resolution cascade: URL params → sessionStorage → 30-day cookie

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
const SESSION_KEY = "hnbcrm_utm";
const COOKIE_NAME = "hnbcrm_utm";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

export interface UtmData {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
}

function readCookie(): UtmData | null {
  try {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]*)`));
    if (!match) return null;
    return JSON.parse(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

function writeCookie(data: UtmData): void {
  try {
    const encoded = encodeURIComponent(JSON.stringify(data));
    document.cookie = `${COOKIE_NAME}=${encoded}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`;
  } catch {
    // cookie write failed, ignore
  }
}

function readSession(): UtmData | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeSession(data: UtmData): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch {
    // sessionStorage unavailable, ignore
  }
}

/**
 * Resolve UTM params with cascade: URL params → sessionStorage → cookie.
 * If URL params are present (fresh click), persist them to sessionStorage + cookie.
 */
export function resolveUtmParams(searchParams: URLSearchParams): UtmData {
  // 1. Check URL params (highest priority — fresh click)
  const fromUrl: UtmData = {};
  let hasUrlUtm = false;

  for (const key of UTM_KEYS) {
    const val = searchParams.get(key);
    if (val) {
      hasUrlUtm = true;
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()) as keyof UtmData;
      fromUrl[camelKey] = val;
    }
  }

  if (hasUrlUtm) {
    // Persist fresh UTM data
    persistUtm(fromUrl);
    return fromUrl;
  }

  // 2. Fallback to sessionStorage
  const fromSession = readSession();
  if (fromSession && Object.keys(fromSession).length > 0) {
    return fromSession;
  }

  // 3. Fallback to cookie (returning visitor)
  const fromCookie = readCookie();
  if (fromCookie && Object.keys(fromCookie).length > 0) {
    return fromCookie;
  }

  return {};
}

/**
 * Persist UTM data to sessionStorage + first-party cookie.
 */
export function persistUtm(data: UtmData): void {
  // Only persist non-empty values
  const clean: UtmData = {};
  for (const [k, v] of Object.entries(data)) {
    if (v) (clean as any)[k] = v;
  }
  if (Object.keys(clean).length === 0) return;

  writeSession(clean);
  writeCookie(clean);
}
