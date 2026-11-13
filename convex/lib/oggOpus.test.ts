import { describe, expect, test } from "vitest";
import { buildSyntheticOggOpus, syntheticVoiceNote } from "./oggOpus.testkit";
import { opusPacketSamples, readOggOpus, repairOggOpusTimeline, sketchWaveform, VOICE_WAVEFORM_BARS } from "./oggOpus";
import { bridgeVoiceNoteFields } from "./bridgeSend";

const fixtureBytes = syntheticVoiceNote;

describe("readOggOpus", () => {
  test("lê a duração e 64 barras de um ogg/opus (bytes sintéticos: 1 s de pacotes grandes + 1 s de pequenos)", () => {
    const info = readOggOpus(fixtureBytes());
    expect(info).not.toBeNull();
    expect(info!.durationSeconds).toBeCloseTo((100 * 960 - 312) / 48000, 4);
    expect(info!.seconds).toBe(2);
    expect(info!.waveform).toHaveLength(VOICE_WAVEFORM_BARS);
    expect(info!.waveform.every((v) => Number.isInteger(v) && v >= 0 && v <= 100)).toBe(true);
    // O trecho de tom pesa mais que o de silêncio no fim.
    expect(info!.waveform.slice(0, 32).every((v) => v === 100)).toBe(true);
    expect(info!.waveform.slice(32).every((v) => v === 0)).toBe(true);
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

  test("áudio muito curto arredonda para 1 segundo, nunca 0; pacote maior que 255 bytes conta inteiro", () => {
    const info = readOggOpus(buildSyntheticOggOpus([300, 10, 10]))!;
    expect(info.durationSeconds).toBeCloseTo((3 * 960 - 312) / 48000, 4);
    expect(info.seconds).toBe(1);
    expect(info.waveform[0]).toBe(100);
  });

  test("pre-skip é descontado da duração", () => {
    expect(readOggOpus(buildSyntheticOggOpus(new Array<number>(50).fill(40), 0))!.durationSeconds).toBeCloseTo(1, 3);
    expect(readOggOpus(buildSyntheticOggOpus(new Array<number>(50).fill(40), 3840))!.durationSeconds).toBeCloseTo(0.92, 3);
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

// Reference CRC written differently from the implementation (bit by bit, no table).
function referenceOggCrc(page: Uint8Array): number {
  let crc = 0;
  for (const byte of page) {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let k = 0; k < 8; k++) crc = (crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1) >>> 0;
  }
  return crc >>> 0;
}

function pagesOf(bytes: Uint8Array): { granule: number; crcOk: boolean }[] {
  const out: { granule: number; crcOk: boolean }[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at + 27 <= bytes.length) {
    const segments = bytes[at + 26];
    let size = 0;
    for (let s = 0; s < segments; s++) size += bytes[at + 27 + s];
    const end = at + 27 + segments + size;
    const page = bytes.slice(at, end);
    const stored = view.getUint32(at + 22, true);
    page.set([0, 0, 0, 0], 22);
    out.push({ granule: view.getUint32(at + 6, true), crcOk: referenceOggCrc(page) === stored });
    at = end;
  }
  return out;
}

describe("repairOggOpusTimeline", () => {
  const sizes = new Array<number>(6).fill(40);

  test("marcação certa: devolve o MESMO array, sem tocar em nada", () => {
    const good = buildSyntheticOggOpus(sizes);
    expect(repairOggOpusTimeline(good)).toBe(good);
  });

  test("primeira página abaixo das amostras que contém (caso do conversor): regrava e acerta o checksum", () => {
    // Igual ao ogg de produção: tudo 312 amostras (o pre-skip) abaixo do certo.
    const broken = buildSyntheticOggOpus(sizes, 312, (i) => (i + 1) * 960 - 312);
    const fixed = repairOggOpusTimeline(broken)!;
    expect(fixed).not.toBe(broken);
    expect(fixed).toHaveLength(broken.length);
    const audio = pagesOf(fixed).slice(2);
    // Só a última página pode ficar abaixo (corte do fim); as demais são a contagem exata.
    expect(audio.slice(0, -1).map((p) => p.granule)).toEqual([960, 1920, 2880, 3840, 4800]);
    expect(audio[audio.length - 1].granule).toBe(6 * 960 - 312);
    expect(audio.every((p) => p.crcOk)).toBe(true);
    // O áudio em si não muda: só cabeçalhos de página.
    expect(readOggOpus(fixed)!.durationSeconds).toBeCloseTo((6 * 960 - 312 - 312) / 48000, 4);
    // Reparar de novo não muda mais nada.
    expect(repairOggOpusTimeline(fixed)).toBe(fixed);
  });

  test("só o corte do fim na última página é válido: fica como está", () => {
    const trimmed = buildSyntheticOggOpus(sizes, 312, (i) => (i === 5 ? 6 * 960 - 400 : (i + 1) * 960));
    expect(repairOggOpusTimeline(trimmed)).toBe(trimmed);
  });

  test("deriva no meio do arquivo também é regravada", () => {
    const drift = buildSyntheticOggOpus(sizes, 312, (i) => (i + 1) * 960 - (i >= 2 ? 24 : 0));
    const fixed = repairOggOpusTimeline(drift)!;
    expect(pagesOf(fixed).slice(2, 7).map((p) => p.granule)).toEqual([960, 1920, 2880, 3840, 4800]);
  });

  test("não é ogg/opus ou está truncado: null, sem lançar", () => {
    expect(repairOggOpusTimeline(new Uint8Array())).toBeNull();
    expect(repairOggOpusTimeline(new TextEncoder().encode("isto-nao-e-um-arquivo-ogg-e-tem-mais-de-27-bytes"))).toBeNull();
    expect(repairOggOpusTimeline(buildSyntheticOggOpus(sizes).subarray(0, 90))).toBeNull();
  });
});

describe("opusPacketSamples", () => {
  test("lê o tamanho do quadro e a contagem de quadros do TOC", () => {
    expect(opusPacketSamples(0xf8, undefined)).toBe(960); // CELT 20 ms, 1 quadro
    expect(opusPacketSamples(0x08, undefined)).toBe(960); // SILK 20 ms, 1 quadro
    expect(opusPacketSamples(0x00, undefined)).toBe(480); // SILK 10 ms
    expect(opusPacketSamples(0xf9, undefined)).toBe(1920); // 2 quadros
    expect(opusPacketSamples(0xfb, 3)).toBe(2880); // código 3: contagem no 2º byte
  });
});
