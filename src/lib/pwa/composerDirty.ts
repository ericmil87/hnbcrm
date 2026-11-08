// "Unsent content" signals: a pending app update must never reload the page under the user's hands.
//  1. Registry: components that hold a draft (Composer, CopilotPanel) mark themselves while they have text.
//  2. Global typing mark: any `input` event (30+ textareas/forms across the app) marks "typed since the last
//     navigation"; PwaUpdateManager resets it when the pathname changes. Persistent drafts (A2) may relax this.
const dirty = new Set<string>();
let typedSinceNavigation = false;

export function setComposerDirty(id: string, isDirty: boolean): void {
  if (isDirty) dirty.add(id);
  else dirty.delete(id);
}

export function isAnyComposerDirty(): boolean {
  return dirty.size > 0;
}

export function hasTypedSinceNavigation(): boolean {
  return typedSinceNavigation;
}

export function resetTypedSignal(): void {
  typedSinceNavigation = false;
}

/** Anything that blocks a silent reload. */
export function hasUnsavedInput(): boolean {
  return typedSinceNavigation || dirty.size > 0;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement || target.isContentEditable;
}

/** Capture-phase listener so components that stop propagation are still seen. Returns the cleanup. */
export function installTypingListener(doc: Document = document): () => void {
  const onInput = (event: Event) => {
    if (isEditable(event.target)) typedSinceNavigation = true;
  };
  doc.addEventListener("input", onInput, true);
  return () => doc.removeEventListener("input", onInput, true);
}
