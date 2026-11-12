import { describe, expect, it } from "vitest";
import {
  VOICE_MESSAGES,
  containerFromMimeType,
  pickVoiceRecordingType,
  resolveVoiceUploadFormat,
  sniffVoiceContainer,
  voiceNoteFileName,
  voiceStartErrorMessage,
  voiceUploadErrorMessage,
} from "./voiceRecordingFormat";

const supports = (types: string[]) => (t: string) => types.includes(t);

// First bytes of each container, as MediaRecorder writes them.
const OGG_HEAD = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0]);
const WEBM_HEAD = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0xf7, 0x81]);
// "....ftypmp42" (Safari: ISO-BMFF with an ftyp box first)
const MP4_HEAD = new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
const UNKNOWN_HEAD = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

describe("pickVoiceRecordingType", () => {
  it("sem MediaRecorder → erro", () => {
    expect(pickVoiceRecordingType(null)).toEqual({ ok: false, error: "no_media_recorder" });
  });

  it("Firefox (ogg/opus) prefere ogg", () => {
    expect(
      pickVoiceRecordingType(supports(["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/webm"]))
    ).toEqual({ ok: true, mimeType: "audio/ogg;codecs=opus" });
  });

  it("Chrome (só webm) escolhe webm/opus", () => {
    expect(pickVoiceRecordingType(supports(["audio/webm;codecs=opus", "audio/webm"]))).toEqual({
      ok: true,
      mimeType: "audio/webm;codecs=opus",
    });
  });

  it("Safari iOS (só mp4) escolhe mp4/AAC", () => {
    expect(pickVoiceRecordingType(supports(["audio/mp4;codecs=mp4a.40.2", "audio/mp4"]))).toEqual({
      ok: true,
      mimeType: "audio/mp4;codecs=mp4a.40.2",
    });
    expect(pickVoiceRecordingType(supports(["audio/mp4"]))).toEqual({ ok: true, mimeType: "audio/mp4" });
  });

  it("Safari que também grava webm mantém a preferência webm > mp4", () => {
    expect(pickVoiceRecordingType(supports(["audio/webm;codecs=opus", "audio/mp4"]))).toEqual({
      ok: true,
      mimeType: "audio/webm;codecs=opus",
    });
  });

  it("nenhum candidato aceito → grava no padrão do navegador (o tipo real decide depois)", () => {
    expect(pickVoiceRecordingType(supports([]))).toEqual({ ok: true, mimeType: "" });
  });

  it("isTypeSupported que lança é tratado como não suportado", () => {
    const throwing = (t: string) => {
      if (t.startsWith("audio/ogg")) throw new Error("boom");
      return t === "audio/mp4";
    };
    expect(pickVoiceRecordingType(throwing)).toEqual({ ok: true, mimeType: "audio/mp4" });
  });
});

describe("sniffVoiceContainer / containerFromMimeType", () => {
  it("reconhece ogg, webm e mp4 pelos primeiros bytes", () => {
    expect(sniffVoiceContainer(OGG_HEAD)).toBe("ogg");
    expect(sniffVoiceContainer(WEBM_HEAD)).toBe("webm");
    expect(sniffVoiceContainer(MP4_HEAD)).toBe("mp4");
    expect(sniffVoiceContainer(UNKNOWN_HEAD)).toBeNull();
    expect(sniffVoiceContainer(new Uint8Array([0x4f, 0x67]))).toBeNull();
  });

  it("reconhece mp4 fragmentado que começa por moof", () => {
    const moof = new Uint8Array([0, 0, 0, 0x10, 0x6d, 0x6f, 0x6f, 0x66, 0, 0, 0, 0]);
    expect(sniffVoiceContainer(moof)).toBe("mp4");
  });

  it("lê o tipo base ignorando parâmetros e caixa", () => {
    expect(containerFromMimeType("audio/mp4;codecs=mp4a.40.2")).toBe("mp4");
    expect(containerFromMimeType("Audio/WebM; codecs=opus")).toBe("webm");
    expect(containerFromMimeType("audio/ogg; codecs=opus")).toBe("ogg");
    expect(containerFromMimeType("audio/x-m4a")).toBe("mp4");
    expect(containerFromMimeType("audio/aac")).toBeNull();
    expect(containerFromMimeType("")).toBeNull();
    expect(containerFromMimeType(undefined)).toBeNull();
  });
});

describe("resolveVoiceUploadFormat", () => {
  it("Chrome: webm/opus → audio/webm .webm", () => {
    expect(
      resolveVoiceUploadFormat({
        head: WEBM_HEAD,
        size: 5000,
        recorderMimeType: "audio/webm;codecs=opus",
        blobType: "audio/webm;codecs=opus",
        requestedMimeType: "audio/webm;codecs=opus",
      })
    ).toEqual({ ok: true, container: "webm", mimeType: "audio/webm", ext: "webm" });
  });

  it("Firefox: ogg/opus → audio/ogg .ogg", () => {
    expect(
      resolveVoiceUploadFormat({
        head: OGG_HEAD,
        size: 5000,
        recorderMimeType: "audio/ogg;codecs=opus",
        requestedMimeType: "audio/ogg;codecs=opus",
      })
    ).toEqual({ ok: true, container: "ogg", mimeType: "audio/ogg", ext: "ogg" });
  });

  it("Safari: mp4/AAC → audio/mp4 .m4a", () => {
    expect(
      resolveVoiceUploadFormat({
        head: MP4_HEAD,
        size: 5000,
        recorderMimeType: "audio/mp4",
        blobType: "audio/mp4",
        requestedMimeType: "audio/mp4;codecs=mp4a.40.2",
      })
    ).toEqual({ ok: true, container: "mp4", mimeType: "audio/mp4", ext: "m4a" });
  });

  it("o tipo real vence o pedido: pediu webm, o Safari gravou mp4", () => {
    const r = resolveVoiceUploadFormat({
      head: MP4_HEAD,
      size: 5000,
      recorderMimeType: "audio/mp4",
      blobType: "audio/mp4",
      requestedMimeType: "audio/webm;codecs=opus",
    });
    expect(r).toMatchObject({ ok: true, mimeType: "audio/mp4", ext: "m4a" });
  });

  it("os bytes vencem o rótulo (rótulo webm, conteúdo mp4)", () => {
    const r = resolveVoiceUploadFormat({
      head: MP4_HEAD,
      size: 5000,
      recorderMimeType: "audio/webm",
      requestedMimeType: "audio/webm",
    });
    expect(r).toMatchObject({ ok: true, mimeType: "audio/mp4", ext: "m4a" });
  });

  it("sem assinatura reconhecida usa o rótulo do gravador", () => {
    const r = resolveVoiceUploadFormat({
      head: UNKNOWN_HEAD,
      size: 5000,
      recorderMimeType: "",
      blobType: "audio/mp4;codecs=mp4a.40.2",
    });
    expect(r).toMatchObject({ ok: true, mimeType: "audio/mp4", ext: "m4a" });
  });

  it("navegador sem rótulo nenhum: vale o tipo pedido", () => {
    const r = resolveVoiceUploadFormat({
      head: UNKNOWN_HEAD,
      size: 5000,
      recorderMimeType: "",
      blobType: "",
      requestedMimeType: "audio/ogg;codecs=opus",
    });
    expect(r).toMatchObject({ ok: true, mimeType: "audio/ogg", ext: "ogg" });
  });

  it("formato desconhecido → erro em vez de upload recusado", () => {
    expect(
      resolveVoiceUploadFormat({ head: UNKNOWN_HEAD, size: 5000, recorderMimeType: "audio/aac" })
    ).toEqual({ ok: false, error: "unsupported_format", detectedType: "audio/aac" });
    expect(resolveVoiceUploadFormat({ head: UNKNOWN_HEAD, size: 5000 })).toEqual({
      ok: false,
      error: "unsupported_format",
      detectedType: "",
    });
  });

  it("gravação vazia → erro", () => {
    expect(
      resolveVoiceUploadFormat({ head: new Uint8Array(), size: 0, recorderMimeType: "audio/mp4" })
    ).toEqual({ ok: false, error: "empty_recording", detectedType: "audio/mp4" });
  });
});

describe("nome e mensagens", () => {
  it("nome do arquivo segue a extensão real", () => {
    expect(voiceNoteFileName({ container: "mp4", mimeType: "audio/mp4", ext: "m4a" }, 123)).toBe(
      "nota-de-voz-123.m4a"
    );
  });

  it("erros do microfone viram mensagens claras", () => {
    expect(voiceStartErrorMessage({ name: "NotAllowedError" })).toBe(VOICE_MESSAGES.permissionDenied);
    expect(voiceStartErrorMessage({ name: "SecurityError" })).toBe(VOICE_MESSAGES.permissionDenied);
    expect(voiceStartErrorMessage({ name: "NotFoundError" })).toBe(VOICE_MESSAGES.noMicrophone);
    expect(voiceStartErrorMessage({ name: "NotReadableError" })).toBe(VOICE_MESSAGES.micBusy);
    expect(voiceStartErrorMessage({ name: "NotSupportedError" })).toBe(VOICE_MESSAGES.formatNotSupported);
    expect(voiceStartErrorMessage(new Error("x"))).toBe(VOICE_MESSAGES.startFailed);
    expect(voiceStartErrorMessage(null)).toBe(VOICE_MESSAGES.startFailed);
  });

  it("erros de formato viram mensagens claras", () => {
    expect(voiceUploadErrorMessage("empty_recording")).toBe(VOICE_MESSAGES.emptyRecording);
    expect(voiceUploadErrorMessage("unsupported_format")).toBe(VOICE_MESSAGES.formatNotSupported);
  });
});
