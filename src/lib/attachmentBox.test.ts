import { describe, expect, it } from "vitest";
import { attachmentBox, IMAGE_BOX_MIN } from "./attachmentBox";

describe("attachmentBox", () => {
  it("paisagem: largura no teto, altura proporcional", () => {
    expect(attachmentBox(1280, 720)).toEqual({ width: 240, height: 135 });
    expect(attachmentBox(4000, 3000)).toEqual({ width: 240, height: 180 });
  });

  it("retrato: altura no teto, largura proporcional", () => {
    expect(attachmentBox(1080, 1920)).toEqual({ width: 135, height: 240 });
    expect(attachmentBox(3000, 4000)).toEqual({ width: 180, height: 240 });
  });

  it("quadrada", () => {
    expect(attachmentBox(1000, 1000)).toEqual({ width: 240, height: 240 });
    expect(attachmentBox(240, 240)).toEqual({ width: 240, height: 240 });
  });

  it("minúscula: tamanho natural, sem ampliar nem aplicar mínimo", () => {
    expect(attachmentBox(20, 20)).toEqual({ width: 20, height: 20 });
    expect(attachmentBox(200, 10)).toEqual({ width: 200, height: 10 });
    expect(attachmentBox(1, 1)).toEqual({ width: 1, height: 1 });
  });

  it("proporção extrema: lado menor mínimo em vez de uma tira", () => {
    expect(attachmentBox(4000, 200)).toEqual({ width: 240, height: IMAGE_BOX_MIN });
    expect(attachmentBox(200, 4000)).toEqual({ width: IMAGE_BOX_MIN, height: 240 });
    // No limite da proporção (240/64) nada muda.
    expect(attachmentBox(2400, 640)).toEqual({ width: 240, height: 64 });
  });

  it("proporção extrema: o mínimo nunca passa do tamanho natural", () => {
    expect(attachmentBox(2000, 30)).toEqual({ width: 240, height: 30 });
    expect(attachmentBox(12, 5000)).toEqual({ width: 12, height: 240 });
  });

  it("figurinha: cabe em 128×128, proporção intacta, sem mínimo", () => {
    expect(attachmentBox(512, 512, "sticker")).toEqual({ width: 128, height: 128 });
    expect(attachmentBox(512, 256, "sticker")).toEqual({ width: 128, height: 64 });
    expect(attachmentBox(1280, 64, "sticker")).toEqual({ width: 128, height: 6 });
    expect(attachmentBox(96, 96, "sticker")).toEqual({ width: 96, height: 96 });
  });

  it("sem dimensões utilizáveis → null (comportamento antigo)", () => {
    expect(attachmentBox(undefined, undefined)).toBeNull();
    expect(attachmentBox(1280, undefined)).toBeNull();
    expect(attachmentBox(null, 720)).toBeNull();
    expect(attachmentBox(0, 720)).toBeNull();
    expect(attachmentBox(-10, 720)).toBeNull();
    expect(attachmentBox(NaN, 720)).toBeNull();
    expect(attachmentBox(Infinity, 720)).toBeNull();
    expect(attachmentBox("1280", "720")).toBeNull();
  });
});
