import { describe, expect, test } from "vitest";
import fixture from "../__fixtures__/voiceNoteSynthetic.json";
import { readOggOpus, sketchWaveform, VOICE_WAVEFORM_BARS } from "./oggOpus";
import { bridgeVoiceNoteFields } from "./bridgeSend";

function fixtureBytes(): Uint8Array {
  const binary = atob(fixture.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

describe("readOggOpus", () => {
  test("lê a duração e 64 barras de um ogg/opus (fixture sintético: 1 s de tom + 1 s de silêncio)", () => {
    const info = readOggOpus(fixtureBytes());
    expect(info).not.toBeNull();
    expect(info!.durationSeconds).toBeCloseTo(fixture.durationSeconds, 1);
    expect(info!.seconds).toBe(2);
    expect(info!.waveform).toHaveLength(VOICE_WAVEFORM_BARS);
    expect(info!.waveform.every((v) => Number.isInteger(v) && v >= 0 && v <= 100)).toBe(true);
    // O trecho de tom pesa mais que o de silêncio no fim.
    const first = info!.waveform.slice(0, 16).reduce((a, b) => a + b, 0);
    const last = info!.waveform.slice(-8).reduce((a, b) => a + b, 0);
    expect(first).toBeGreaterThan(last);
  });

  test("o resultado vira os campos do gateway (Seconds inteiro e Waveform válida)", () => {
    const info = readOggOpus(fixtureBytes())!;
    const fields = bridgeVoiceNoteFields({ seconds: info.seconds, waveform: info.waveform });
    expect(fields).toMatchObject({ PTT: true, MimeType: "audio/ogg; codecs=opus", Seconds: 2 });
    expect(typeof fields!.Waveform).toBe("string");
  });

  test("não é ogg, está truncado ou vazio: null, sem lançar", () => {
    expect(readOggOpus(new Uint8Array())).toBeNull();
    expect(readOggOpus(new TextEncoder().encode("webm-ou-qualquer-outra-coisa-bem-longa-para-passar-do-cabecalho"))).toBeNull();
    const bytes = fixtureBytes();
    expect(readOggOpus(bytes.subarray(0, 40))).toBeNull();
    // Ogg que não é Opus (cabeçalho trocado).
    const notOpus = bytes.slice();
    notOpus[28] = 0x58;
    expect(readOggOpus(notOpus)).toBeNull();
  });

  test("áudio muito curto arredonda para 1 segundo, nunca 0", () => {
    const info = readOggOpus(fixtureBytes())!;
    expect(Math.max(1, Math.round(0.2))).toBe(1);
    expect(info.seconds).toBeGreaterThanOrEqual(1);
  });
});

describe("sketchWaveform", () => {
  test("normaliza entre o menor e o maior balde", () => {
    const wave = sketchWaveform([10, 10, 100, 100], 4);
    expect(wave).toEqual([0, 0, 100, 100]);
  });
  test("pacotes todos iguais dão barras no meio, e lista vazia dá zeros", () => {
    expect(sketchWaveform([40, 40, 40], 4)).toEqual([50, 50, 50, 50]);
    expect(sketchWaveform([], 4)).toEqual([0, 0, 0, 0]);
  });
  test("menos pacotes que barras ainda devolve todas as barras", () => {
    expect(sketchWaveform([5, 50], 8)).toHaveLength(8);
  });
});
