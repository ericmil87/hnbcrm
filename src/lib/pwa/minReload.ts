export const MIN_RELOAD_KEY = "hnbcrm:min-reload";

type Store = Pick<Storage, "getItem" | "setItem">;

/**
 * Below MIN_CLIENT_BUILD with no new service worker waiting, a plain reload is the last resort. It is
 * allowed at most once per `min` value (sessionStorage), so a MIN_CLIENT_BUILD higher than the published
 * version can never cause a reload loop. Returns true when the caller may reload now.
 */
export function claimMinReload(min: string, storage: Store | null): boolean {
  try {
    if (!storage) return false;
    if (storage.getItem(MIN_RELOAD_KEY) === min) return false;
    storage.setItem(MIN_RELOAD_KEY, min);
    return true;
  } catch {
    return false;
  }
}
