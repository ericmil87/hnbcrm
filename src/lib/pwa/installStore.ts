import { readStandalone } from "./platform";

/** Chrome/Edge/Android install event (non-standard, so typed here). */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export interface InstallState {
  /** A captured `beforeinstallprompt` is ready to be triggered. */
  canPrompt: boolean;
  /** Running as an installed app, or just installed in this session. */
  installed: boolean;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installedNow = false;
let started = false;
let state: InstallState = { canPrompt: false, installed: false };
const listeners = new Set<() => void>();

function publish() {
  const next: InstallState = { canPrompt: deferred !== null, installed: installedNow || readStandalone() };
  if (next.canPrompt === state.canPrompt && next.installed === state.installed) return;
  state = next;
  listeners.forEach((l) => l());
}

/** Must run early (shell module load): the browser fires the event once, possibly before the UI mounts. */
export function startInstallCapture(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    publish();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installedNow = true;
    publish();
  });
  publish();
}

export function getInstallState(): InstallState {
  return state;
}

export function subscribeInstallState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Opens the native install dialog. Returns the outcome, or null when no prompt is available. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | null> {
  const ev = deferred;
  if (!ev) return null;
  deferred = null; // a captured event can be used only once
  publish();
  try {
    await ev.prompt();
    const choice = await ev.userChoice;
    return choice.outcome;
  } catch {
    return null;
  }
}

/** Test helper. */
export function __resetInstallStoreForTests(): void {
  deferred = null;
  installedNow = false;
  started = false;
  state = { canPrompt: false, installed: false };
  listeners.clear();
}
