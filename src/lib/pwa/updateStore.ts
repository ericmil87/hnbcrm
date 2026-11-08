// Tiny external store bridging the module-level SW registration (main.tsx) and the React manager.
export interface UpdateState {
  /** A new service worker is installed and waiting to take over. */
  waiting: boolean;
}

let state: UpdateState = { waiting: false };
let applyHandler: (() => void) | null = null;
const listeners = new Set<() => void>();

export function getUpdateState(): UpdateState {
  return state;
}

export function subscribeUpdateState(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setUpdateWaiting(waiting: boolean, apply: (() => void) | null): void {
  state = { waiting };
  applyHandler = apply;
  listeners.forEach((l) => l());
}

/** Activates the waiting SW (page reloads once it controls). Returns false when nothing is waiting. */
export function applyWaitingUpdate(): boolean {
  if (!applyHandler) return false;
  applyHandler();
  return true;
}
