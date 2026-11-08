// Pure helpers for the build id (`__APP_BUILD__`) and the minimum client build. No Vite/DOM APIs:
// vite.config.ts imports `makeBuildId` (typechecked by tsconfig.node.json).

/** "0.78.1+abc1234" (git sha) or "0.78.1+t20261107T2204" (timestamp fallback). */
export function makeBuildId(opts: { version: string; sha?: string | null; now: Date }): string {
  const sha = (opts.sha ?? "").trim().slice(0, 7);
  if (sha) return `${opts.version}+${sha}`;
  const stamp = opts.now.toISOString().replace(/[-:]/g, "").slice(0, 13);
  return `${opts.version}+t${stamp}`;
}

function numericParts(build: string): number[] | null {
  const core = build.trim().replace(/^v/i, "").split("+")[0].split("-")[0];
  if (!/^\d+(\.\d+)*$/.test(core)) return null;
  return core.split(".").map(Number);
}

/**
 * Compares the dotted-numeric part of two builds; the "+sha"/"+timestamp" suffix is ignored
 * (hashes have no order). Returns -1 when `a` is older than `b`, 1 when newer, 0 when equal.
 * Anything unparseable returns 0 so a bad MIN_CLIENT_BUILD can never lock users out.
 */
export function compareBuild(a: string, b: string): -1 | 0 | 1 {
  const pa = numericParts(a);
  const pb = numericParts(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** True when `current` is below a non-empty `min`. */
export function isBelowMinimum(current: string, min: string | null | undefined): boolean {
  return !!min && compareBuild(current, min) < 0;
}
