import { describe, expect, it } from "vitest";
import { getFileCategory, validateFileUpload, validateMimeType } from "./fileValidation";

// Notas de voz gravadas no navegador: o front (src/lib/voiceRecordingFormat.ts)
// sobe audio/ogg (.ogg), audio/webm (.webm) ou audio/mp4 (.m4a, Safari/iPhone).
describe("fileValidation — notas de voz do gravador", () => {
  it.each([
    ["audio/mp4", "nota-de-voz-1.m4a"],
    ["audio/webm", "nota-de-voz-1.webm"],
    ["audio/ogg", "nota-de-voz-1.ogg"],
  ])("aceita %s (%s)", (mimeType, name) => {
    expect(() => validateFileUpload({ mimeType, size: 120_000, name })).not.toThrow();
    expect(getFileCategory(mimeType)).toBe("audio");
  });

  it("aceita o tipo com parâmetros de codec (como o MediaRecorder informa)", () => {
    expect(validateMimeType("audio/mp4;codecs=mp4a.40.2")).toBe(true);
    expect(validateMimeType("audio/webm;codecs=opus")).toBe(true);
    expect(() =>
      validateFileUpload({ mimeType: "audio/mp4;codecs=mp4a.40.2", size: 1000, name: "nota-de-voz-1.m4a" })
    ).not.toThrow();
  });

  it("recusa nota de voz acima de 10 MB", () => {
    expect(() =>
      validateFileUpload({ mimeType: "audio/mp4", size: 11 * 1024 * 1024, name: "nota-de-voz-1.m4a" })
    ).toThrow(/muito grande/);
  });

  it("audio/aac cru não entra pelo upload humano (só por mídia recebida)", () => {
    expect(validateMimeType("audio/aac")).toBe(false);
  });
});
