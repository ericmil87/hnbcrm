import { describe, expect, test } from "vitest";
import {
  headOfChunks,
  imageSizeFields,
  MAX_IMAGE_DIMENSION,
  readImageSize,
  sanitizeImageSize,
} from "./imageSize";
import {
  gifBytes,
  jpegBytes,
  pngBytes,
  webpExtendedBytes,
  webpLosslessBytes,
  webpLossyBytes,
} from "./imageSize.testkit";

describe("readImageSize", () => {
  test("PNG (IHDR)", () => {
    expect(readImageSize(pngBytes(1080, 1920))).toEqual({ width: 1080, height: 1920 });
  });

  test("GIF 87a e 89a", () => {
    expect(readImageSize(gifBytes(320, 240))).toEqual({ width: 320, height: 240 });
    expect(readImageSize(gifBytes(1, 1, "87a"))).toEqual({ width: 1, height: 1 });
  });

  test("WebP: VP8, VP8L e VP8X", () => {
    expect(readImageSize(webpLossyBytes(512, 384))).toEqual({ width: 512, height: 384 });
    expect(readImageSize(webpLosslessBytes(512, 512))).toEqual({ width: 512, height: 512 });
    expect(readImageSize(webpLosslessBytes(16383, 3))).toEqual({ width: 16383, height: 3 });
    expect(readImageSize(webpExtendedBytes(1600, 900))).toEqual({ width: 1600, height: 900 });
  });

  test("JPEG: SOF0/1/2, pulando APPn, DQT e DHT", () => {
    expect(readImageSize(jpegBytes(1280, 720))).toEqual({ width: 1280, height: 720 });
    expect(readImageSize(jpegBytes(640, 480, { sof: 0xc1 }))).toEqual({ width: 640, height: 480 });
    expect(readImageSize(jpegBytes(3000, 4000, { sof: 0xc2 }))).toEqual({ width: 3000, height: 4000 });
    expect(readImageSize(jpegBytes(800, 600, { filler: 5000 }))).toEqual({ width: 800, height: 600 });
  });

  test("JPEG: orientação EXIF 5–8 troca largura e altura; 1–4 não", () => {
    for (const orientation of [1, 2, 3, 4]) {
      expect(readImageSize(jpegBytes(4000, 3000, { orientation }))).toEqual({ width: 4000, height: 3000 });
    }
    for (const orientation of [5, 6, 7, 8]) {
      expect(readImageSize(jpegBytes(4000, 3000, { orientation }))).toEqual({ width: 3000, height: 4000 });
    }
    expect(
      readImageSize(jpegBytes(4000, 3000, { orientation: 6, littleEndianExif: true }))
    ).toEqual({ width: 3000, height: 4000 });
    // Orientação inválida é ignorada.
    expect(readImageSize(jpegBytes(4000, 3000, { orientation: 9 }))).toEqual({ width: 4000, height: 3000 });
  });

  test("aceita ArrayBuffer", () => {
    const bytes = pngBytes(10, 20);
    expect(readImageSize(bytes.buffer.slice(0) as ArrayBuffer)).toEqual({ width: 10, height: 20 });
  });

  test("JPEG cortado antes do SOF (janela curta) → null", () => {
    const bytes = jpegBytes(800, 600, { filler: 5000 });
    expect(readImageSize(bytes.subarray(0, 2000))).toBeNull();
  });

  test("entrada curta, vazia, nula ou de outro formato → null, sem lançar", () => {
    expect(readImageSize(null)).toBeNull();
    expect(readImageSize(undefined)).toBeNull();
    expect(readImageSize(new Uint8Array(0))).toBeNull();
    expect(readImageSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(readImageSize(pngBytes(10, 10).subarray(0, 20))).toBeNull();
    expect(readImageSize(new TextEncoder().encode("%PDF-1.7 um documento qualquer"))).toBeNull();
    expect(readImageSize(new TextEncoder().encode("RIFF....WAVEfmt mais bytes aqui....."))).toBeNull();
  });

  test("todo prefixo de todo formato é seguro (nunca lança)", () => {
    const samples = [
      pngBytes(100, 50),
      gifBytes(100, 50),
      webpLossyBytes(100, 50),
      webpLosslessBytes(100, 50),
      webpExtendedBytes(100, 50),
      jpegBytes(100, 50, { orientation: 6 }),
    ];
    for (const sample of samples) {
      for (let n = 0; n <= sample.length; n++) {
        const got = readImageSize(sample.subarray(0, n));
        if (got) expect(got.width * got.height).toBe(5000);
      }
    }
  });

  test("JPEG malformado: comprimento de segmento zerado ou lixo → null", () => {
    const bytes = jpegBytes(100, 50);
    const broken = bytes.slice();
    broken[4] = 0; // comprimento do APP0 = 0
    broken[5] = 0;
    expect(readImageSize(broken)).toBeNull();
    const garbage = bytes.slice();
    garbage[2] = 0x12; // onde devia haver 0xFF
    expect(readImageSize(garbage)).toBeNull();
  });

  test("valores absurdos (0 ou acima do teto) → null", () => {
    expect(readImageSize(pngBytes(0, 100))).toBeNull();
    expect(readImageSize(pngBytes(100, 0))).toBeNull();
    expect(readImageSize(pngBytes(MAX_IMAGE_DIMENSION + 1, 100))).toBeNull();
    expect(readImageSize(pngBytes(0xffffffff, 0xffffffff))).toBeNull();
    expect(readImageSize(gifBytes(0, 0))).toBeNull();
    expect(readImageSize(jpegBytes(0, 600))).toBeNull();
    expect(readImageSize(jpegBytes(30000, 600))).toBeNull();
    expect(readImageSize(pngBytes(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION))).toEqual({
      width: MAX_IMAGE_DIMENSION,
      height: MAX_IMAGE_DIMENSION,
    });
  });
});

describe("sanitizeImageSize (valores vindos do cliente)", () => {
  test("par válido de imagem passa", () => {
    expect(sanitizeImageSize("image/jpeg", 1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(sanitizeImageSize("IMAGE/PNG", 1, 20000)).toEqual({ width: 1, height: 20000 });
  });

  test("qualquer coisa fora disso vira {} (ignora, sem erro)", () => {
    expect(sanitizeImageSize("application/pdf", 1280, 720)).toEqual({});
    expect(sanitizeImageSize("image/jpeg", undefined, 720)).toEqual({});
    expect(sanitizeImageSize("image/jpeg", 1280, undefined)).toEqual({});
    expect(sanitizeImageSize("image/jpeg", 0, 720)).toEqual({});
    expect(sanitizeImageSize("image/jpeg", -5, 720)).toEqual({});
    expect(sanitizeImageSize("image/jpeg", 12.5, 720)).toEqual({});
    expect(sanitizeImageSize("image/jpeg", NaN, 720)).toEqual({});
    expect(sanitizeImageSize("image/jpeg", Infinity, 720)).toEqual({});
    expect(sanitizeImageSize("image/jpeg", 20001, 720)).toEqual({});
    expect(sanitizeImageSize("image/jpeg", "1280", 720)).toEqual({});
  });
});

describe("imageSizeFields / headOfChunks", () => {
  test("só mede image/*", () => {
    expect(imageSizeFields("image/png", pngBytes(64, 32))).toEqual({ width: 64, height: 32 });
    expect(imageSizeFields("audio/ogg", pngBytes(64, 32))).toEqual({});
    expect(imageSizeFields("image/png", new Uint8Array(4))).toEqual({});
  });

  test("junta o começo dos pedaços até o teto", () => {
    const bytes = jpegBytes(640, 480, { orientation: 8 });
    const chunks = [bytes.subarray(0, 7), bytes.subarray(7, 40), bytes.subarray(40)];
    expect(Array.from(headOfChunks(chunks))).toEqual(Array.from(bytes));
    expect(readImageSize(headOfChunks(chunks))).toEqual({ width: 480, height: 640 });
    expect(Array.from(headOfChunks(chunks, 10))).toEqual(Array.from(bytes.subarray(0, 10)));
    expect(headOfChunks([]).length).toBe(0);
  });
});
