// @vitest-environment node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

// Roda o guard de scripts/claude/check-no-loss.mjs: todo identificador do CLAUDE.md de
// baseline (code spans e títulos em negrito) precisa existir em algum doc do corpus.
describe("CLAUDE.md no-loss", () => {
  test("nenhum identificador do baseline sumiu da documentação", () => {
    const script = resolve(__dirname, "../scripts/claude/check-no-loss.mjs");
    let output = "";
    try {
      output = execFileSync("node", [script], { encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string };
      throw new Error(
        `${err.stderr ?? err.stdout}\nPara aceitar a remoção, adicione o identificador a "allowlist" em scripts/claude/no-loss-baseline.json.`,
      );
    }
    expect(output).toContain("OK");
  });
});
