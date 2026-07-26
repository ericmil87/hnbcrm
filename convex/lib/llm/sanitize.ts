// Credential scrubbing for anything that might end up logged, persisted to
// agentRuns.error, or surfaced in a UI. NEVER throws — on any unexpected input
// it returns a safe placeholder. Keep this defensive: an error path must not
// itself leak a key.

const MAX_LEN = 500;

// Order matters: header-name patterns first (they capture the value that
// follows), then bare token shapes.
const REDACTIONS: { re: RegExp; replacement: string }[] = [
  // "Authorization: Bearer sk-..." / "Authorization = <token>"
  { re: /(authorization)\s*[:=]\s*\S+/gi, replacement: "$1: [REDACTED]" },
  // "api-key: <token>", "x-api-key: <token>"
  { re: /((?:x-)?api-key)\s*[:=]\s*\S+/gi, replacement: "$1: [REDACTED]" },
  // Bearer tokens anywhere.
  { re: /Bearer\s+\S+/gi, replacement: "Bearer [REDACTED]" },
  // OpenAI-style secret keys (sk-..., sk-proj-..., sk-or-...).
  { re: /sk-[A-Za-z0-9_-]{8,}/g, replacement: "[REDACTED]" },
];

export function sanitizeLlmError(message: string): string {
  try {
    let out = typeof message === "string" ? message : String(message);
    for (const { re, replacement } of REDACTIONS) {
      out = out.replace(re, replacement);
    }
    if (out.length > MAX_LEN) out = out.slice(0, MAX_LEN) + "…";
    return out;
  } catch {
    return "[unavailable]";
  }
}
