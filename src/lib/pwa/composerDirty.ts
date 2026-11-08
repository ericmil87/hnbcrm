// Tiny registry: composers with unsent content mark themselves so a pending app update never reloads
// the page under the user's hands. Replaced/relaxed by the persistent draft (A2).
const dirty = new Set<string>();

export function setComposerDirty(id: string, isDirty: boolean): void {
  if (isDirty) dirty.add(id);
  else dirty.delete(id);
}

export function isAnyComposerDirty(): boolean {
  return dirty.size > 0;
}
