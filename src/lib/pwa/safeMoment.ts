export interface SafeMomentInput {
  /** `document.visibilityState === "hidden"` */
  documentHidden: boolean;
  /** The user just navigated to another route (tab still visible). */
  routeChanged: boolean;
  /** Any composer holds unsent text or staged files (see composerDirty.ts). */
  composerDirty: boolean;
}

/**
 * A reload is safe when nothing the user typed can be lost (no dirty composer) AND the user is not
 * looking at the page (hidden) or has just moved to another screen. Persistent drafts (A2) may relax this.
 */
export function isSafeMomentToReload({ documentHidden, routeChanged, composerDirty }: SafeMomentInput): boolean {
  if (composerDirty) return false;
  return documentHidden || routeChanged;
}
