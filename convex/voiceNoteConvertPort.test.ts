// @vitest-environment node
/**
 * Teste de BUILD das portas de voz (P4.1):
 *  - só `lib/voiceNoteConvert.ts` chama o conversor da VPS (`/convert?target=…`):
 *    dispatch do bridge e resposta em áudio do atendente passam por ele;
 *  - só `voiceReplyNode.ts` chama o TTS (`/audio/speech`): custo medido, teto em
 *    R$ checado antes, trava de retenção no corpo, falha = texto. Um TTS novo
 *    (ex.: o chat do onboarding, P4.2) estende esta porta em vez de abrir outra.
 *  - o atendente decide a voz por `planVoiceReply` (regras fixas em `lib/tts.ts`)
 *    e o envio continua só pela porta `scheduleOutboundDispatch` (guard próprio).
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const CONVEX_DIR = __dirname;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "_generated" || entry === "__fixtures__" || entry === "node_modules") continue;
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry) && !entry.includes(".test-")) acc.push(p);
  }
  return acc;
}

const sources = walk(CONVEX_DIR).map((file) => ({
  rel: path.relative(CONVEX_DIR, file).split(path.sep).join("/"),
  src: readFileSync(file, "utf8"),
}));

describe("portas de voz", () => {
  test("conversor `/convert?target=` só em lib/voiceNoteConvert.ts", () => {
    const offenders = sources.filter((f) => /\/convert\?target=/.test(f.src) && f.rel !== "lib/voiceNoteConvert.ts");
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });

  test("TTS `/audio/speech` só em voiceReplyNode.ts", () => {
    const offenders = sources.filter((f) => /\/audio\/speech/.test(f.src) && f.rel !== "voiceReplyNode.ts");
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });

  test("o atendente decide a voz pela regra pura e sintetiza pela porta", () => {
    const attendant = sources.find((f) => f.rel === "attendant.ts")!.src;
    expect(attendant).toMatch(/planVoiceReply\(/);
    expect(attendant).toMatch(/internal\.voiceReplyNode\.internalSynthesizeVoiceNote/);
    // A decisão vem DEPOIS da trava final do guard e da formatação por canal.
    const guard = attendant.indexOf("const finalLeak = detectLeakedModelMarkup(replyText)");
    const format = attendant.indexOf("replyText = formatReplyForTransport(replyText");
    const decide = attendant.indexOf("const voice = await prepareVoiceReply(");
    const commit = attendant.indexOf("internal.attendant.internalCommitAiReply, {", decide);
    expect(guard).toBeGreaterThan(0);
    expect(format).toBeGreaterThan(guard);
    expect(decide).toBeGreaterThan(format);
    expect(commit).toBeGreaterThan(decide);
  });
});
