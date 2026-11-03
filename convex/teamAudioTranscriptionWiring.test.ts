// @vitest-environment node
/**
 * Build guard (lê o fonte): a importação de histórico do bridge marca o ingest
 * com `fromHistory: true`, o que vira `metadata.importedFromHistory` e suprime
 * a transcrição automática (dias de áudio velho não vão ao Whisper em lote).
 * O comportamento do marcador é testado em `teamAudioTranscription.test.ts`.
 */
import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const bridgeSource = readFileSync(path.join(__dirname, "bridge.ts"), "utf8");

test("internalImportBridgeHistory passa fromHistory: true ao ingest", () => {
  const start = bridgeSource.indexOf("export const internalImportBridgeHistory");
  expect(start).toBeGreaterThan(-1);
  const body = bridgeSource.slice(start);
  const call = body.indexOf("internal.bridge.internalIngestBridgeMessage");
  expect(call).toBeGreaterThan(-1);
  expect(body.slice(call, call + 200)).toMatch(/fromHistory:\s*true/);
});
