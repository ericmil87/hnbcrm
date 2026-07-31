// @vitest-environment node
import { expect, test } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Guard de build contra vazamento de segredos (incidente GitGuardian 2026-07:
// uma OPENCODE_GO_API real foi commitada como fixture de teste em
// attendant.test.ts). Qualquer token real-parecido em arquivo rastreado quebra
// o build — fixtures de teste devem ser curtos e obviamente falsos
// ("sk-test-...", "sk-fake-...", "fake-hmac-secret-...").
const PATTERNS: { name: string; re: RegExp }[] = [
  // Chaves estilo OpenAI/OpenRouter/OpenCode (reais têm 40+ chars após "sk-";
  // fixtures curtos como "sk-test-secret-key" passam).
  { name: "sk- API key", re: /sk-[A-Za-z0-9_-]{30,}/ },
  // Resend (re_...) — lookbehind evita falso positivo em identifiers tipo "feature_flag_x".
  { name: "Resend API key", re: /(?<![A-Za-z0-9_])re_[A-Za-z0-9_]{20,}/ },
  { name: "webhook signing secret", re: /whsec_[A-Za-z0-9+/=]{20,}/ },
  // Meta Graph API access tokens (canal WhatsApp oficial).
  { name: "Meta access token", re: /EAA[A-Za-z0-9]{40,}/ },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: "private key block", re: /-----BEGIN (RSA )?PRIVATE KEY-----/ },
  // Tokens hex de 64 chars (HMAC do bridge, admin token do wuzapi, Whisper).
  { name: "64-hex token", re: /\b[a-f0-9]{64}\b/ },
];

const SCAN_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|mts|json|md|mdc|html|css|ya?ml|txt|sh)$/i;
const EXCLUDED_FILES = /(^|\/)package-lock\.json$/;

test("nenhum arquivo rastreado contém segredo real-parecido", () => {
  const files = execSync("git ls-files", { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && SCAN_EXTENSIONS.test(f) && !EXCLUDED_FILES.test(f));
  expect(files.length).toBeGreaterThan(100); // sanity: o ls-files funcionou

  const hits: string[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const { name, re } of PATTERNS) {
      const match = content.match(re);
      if (match) hits.push(`${file}: ${name} — "${match[0].slice(0, 14)}…"`);
    }
  }
  expect(hits, `Possível segredo commitado:\n${hits.join("\n")}`).toEqual([]);
});
