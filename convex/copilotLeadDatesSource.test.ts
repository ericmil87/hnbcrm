// @vitest-environment node
/**
 * v0.78.1 guards read from the source: the period filter of listLeads goes
 * through `by_organization_and_created` (never `.filter` on the query), and
 * only the Telegram path sends a vocabulary prompt to Whisper.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const src = (f: string) => readFileSync(path.join(__dirname, f), "utf8");

describe("v0.78.1 — fontes", () => {
  test("listLeads por período usa o índice by_organization_and_created, sem .filter na query", () => {
    const copilot = src("copilot.ts");
    const body = copilot.slice(copilot.indexOf("async function listLeadsTool("), copilot.indexOf("function leadRow("));
    expect(body).toContain('withIndex("by_organization_and_created"');
    expect(body).not.toMatch(/\.filter\(\s*\(?q\b/);
  });

  test("só o caminho do Telegram passa prompt ao Whisper; o inbound não", () => {
    const transcription = src("transcription.ts");
    const calls = [...transcription.matchAll(/callWhisper\(([^)]*)\)/g)].map((m) => m[1]!);
    // definition + autoTranscribe (3 args) + internalTranscribeStoredAudio (prompt)
    const withPrompt = calls.filter((c) => c.includes("prompt") && !c.includes("serviceUrl: string"));
    expect(withPrompt).toHaveLength(1);
    // The inbound/team path (runTranscription → callWhisper) never sends a prompt
    // (it only passes the size-based timeout as the 4th argument).
    const inbound = transcription.slice(transcription.indexOf("async function runTranscription("));
    const inboundCall = inbound.slice(inbound.indexOf("callWhisper("), inbound.indexOf("});", inbound.indexOf("callWhisper(")));
    expect(inboundCall).toMatch(/^callWhisper\(serviceUrl!?, serviceToken, audioUrl, \{ timeoutMs\s*$/);
    expect(inboundCall).not.toContain("prompt");
    expect(src("telegramCopilot.ts")).toMatch(/internalTranscribeStoredAudio,\s*\{[^}]*prompt: voicePrompt\(/);
  });
});
