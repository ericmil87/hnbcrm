export const UPDATED_FLAG_KEY = "hnbcrm:updated";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function session(): Store | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Remembers (for the next page load) that the reload was an app update. */
export function markUpdatedReload(storage: Store | null = session()): void {
  try {
    storage?.setItem(UPDATED_FLAG_KEY, "1");
  } catch {
    /* storage unavailable: the "Atualizado" toast is just skipped */
  }
}

/** True once after an update reload. */
export function consumeUpdatedFlag(storage: Store | null = session()): boolean {
  try {
    if (!storage || storage.getItem(UPDATED_FLAG_KEY) !== "1") return false;
    storage.removeItem(UPDATED_FLAG_KEY);
    return true;
  } catch {
    return false;
  }
}
