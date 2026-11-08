import { APP_BUILD } from "./appBuild";

export const UPDATED_FLAG_KEY = "hnbcrm:updated";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function session(): Store | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Remembers (for the next page load) the build we are leaving, right before an update reload. */
export function markUpdatedReload(storage: Store | null = session(), previousBuild: string = APP_BUILD): void {
  try {
    storage?.setItem(UPDATED_FLAG_KEY, previousBuild);
  } catch {
    /* storage unavailable: the "Atualizado" toast is just skipped */
  }
}

/** True once after a reload that really changed the build (a reload that kept the same build says nothing). */
export function consumeUpdatedFlag(storage: Store | null = session(), currentBuild: string = APP_BUILD): boolean {
  try {
    if (!storage) return false;
    const previous = storage.getItem(UPDATED_FLAG_KEY);
    if (previous === null) return false;
    storage.removeItem(UPDATED_FLAG_KEY);
    return previous !== currentBuild;
  } catch {
    return false;
  }
}
