/// <reference types="vite/client" />
import { expect, test, describe } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  buildBridgeDownloadRequest,
  descriptorFileLength,
  parseBridgeDownloadResponse,
  toDataUri,
} from "./lib/bridgeMedia";
import {
  bridgeSendKindForMime,
  buildBridgeMediaSendRequest,
  voiceNoteConvertFilename,
  bridgeAudioNeedsConversion,
  planBridgeAudioSend,
  BRIDGE_AUDIO_AS_DOCUMENT_NOTE,
} from "./lib/bridgeSend";
import { checkMetaWhatsappAudio } from "./lib/metaWhatsappAudio";

// ── Fake fixtures only. VALIDAR com gateway real no piloto (U6). ──
const BASE_URL = "https://wuzapi.example.com";
const TOKEN = "fake-instance-token";

describe("bridgeMedia download adapter (pure)", () => {
  test("buildBridgeDownloadRequest routes by kind and echoes the descriptor", () => {
    const req = buildBridgeDownloadRequest({
      baseUrl: BASE_URL,
      token: TOKEN,
      kind: "image",
      descriptor: {
        url: "https://cdn/fake",
        directPath: "/v/fake",
        mediaKey: "ZmFrZQ==",
        mimetype: "image/jpeg",
        fileEncSha256: "ZW5j",
        fileSha256: "cGxhaW4=",
        fileLength: "1234",
      },
    });
    expect(req.url).toBe("https://wuzapi.example.com/chat/downloadimage");
    expect(req.headers.token).toBe(TOKEN);
    const body = JSON.parse(req.body);
    expect(body).toMatchObject({
      Url: "https://cdn/fake",
      DirectPath: "/v/fake",
      MediaKey: "ZmFrZQ==",
      Mimetype: "image/jpeg",
      FileEncSHA256: "ZW5j",
      FileSHA256: "cGxhaW4=",
      FileLength: "1234",
    });
  });

  test("buildBridgeDownloadRequest maps every kind (sticker reuses image)", () => {
    const p = (kind: any) =>
      buildBridgeDownloadRequest({ baseUrl: BASE_URL, token: TOKEN, kind, descriptor: {} }).url;
    expect(p("image")).toContain("/chat/downloadimage");
    expect(p("sticker")).toContain("/chat/downloadimage");
    expect(p("audio")).toContain("/chat/downloadaudio");
    expect(p("video")).toContain("/chat/downloadvideo");
    expect(p("document")).toContain("/chat/downloaddocument");
  });

  test("buildBridgeDownloadRequest reads PascalCase descriptor keys too", () => {
    const req = buildBridgeDownloadRequest({
      baseUrl: BASE_URL,
      token: TOKEN,
      kind: "document",
      descriptor: { URL: "u", DirectPath: "dp", MediaKey: "mk" },
    });
    const body = JSON.parse(req.body);
    expect(body).toMatchObject({ Url: "u", DirectPath: "dp", MediaKey: "mk" });
    // Absent fields are dropped, not sent as null.
    expect("Mimetype" in body).toBe(false);
  });

  test("parseBridgeDownloadResponse extracts a data-URI payload + mime", () => {
    const result = parseBridgeDownloadResponse(true, 200, {
      code: 200,
      success: true,
      data: { Data: "data:image/png;base64,QUJD", Mimetype: "image/png" },
    });
    expect(result).toEqual({ ok: true, base64: "QUJD", mimeType: "image/png" });
  });

  test("parseBridgeDownloadResponse accepts a bare base64 payload", () => {
    const result = parseBridgeDownloadResponse(true, 200, { data: { data: "QUJD" } });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.base64).toBe("QUJD");
  });

  test("parseBridgeDownloadResponse reports a readable error on failure", () => {
    const result = parseBridgeDownloadResponse(false, 500, { success: false, error: "media expired" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("media expired");
  });

  test("parseBridgeDownloadResponse fails when ok but no bytes", () => {
    const result = parseBridgeDownloadResponse(true, 200, { success: true, data: {} });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("bytes");
  });

  test("descriptorFileLength parses number and string uint64", () => {
    expect(descriptorFileLength({ fileLength: 42 })).toBe(42);
    expect(descriptorFileLength({ FileLength: "9999" })).toBe(9999);
    expect(descriptorFileLength({})).toBeUndefined();
    expect(descriptorFileLength(undefined)).toBeUndefined();
  });

  test("base64 round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 128, 255, 65, 66]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  test("toDataUri builds a data URI and falls back to octet-stream", () => {
    const bytes = new Uint8Array([65, 66, 67]);
    expect(toDataUri(bytes, "image/jpeg")).toBe("data:image/jpeg;base64,QUJD");
    expect(toDataUri(bytes, "")).toBe("data:application/octet-stream;base64,QUJD");
  });
});

describe("bridgeSend media builders (pure)", () => {
  test("bridgeSendKindForMime maps by mime prefix, else document", () => {
    expect(bridgeSendKindForMime("image/webp")).toBe("image");
    expect(bridgeSendKindForMime("audio/ogg")).toBe("audio");
    expect(bridgeSendKindForMime("video/mp4")).toBe("video");
    expect(bridgeSendKindForMime("application/pdf")).toBe("document");
  });

  test("voiceNoteConvertFilename: extensão só para mp4/m4a/aac; webm segue voice-note", () => {
    // Safari/iPhone grava mp4/AAC; Chrome webm/opus (caminho que já funciona).
    expect(voiceNoteConvertFilename("audio/mp4")).toBe("voice-note.m4a");
    expect(voiceNoteConvertFilename("audio/mp4;codecs=mp4a.40.2")).toBe("voice-note.m4a");
    expect(voiceNoteConvertFilename("audio/x-m4a")).toBe("voice-note.m4a");
    expect(voiceNoteConvertFilename("audio/aac")).toBe("voice-note.aac");
    expect(voiceNoteConvertFilename("audio/webm;codecs=opus")).toBe("voice-note");
    expect(voiceNoteConvertFilename("audio/ogg; codecs=opus")).toBe("voice-note");
    expect(voiceNoteConvertFilename("application/octet-stream")).toBe("voice-note");
    expect(voiceNoteConvertFilename("")).toBe("voice-note");
  });

  test("bridgeAudioNeedsConversion: só ogg dispensa o /convert", () => {
    expect(bridgeAudioNeedsConversion("audio/ogg; codecs=opus")).toBe(false);
    expect(bridgeAudioNeedsConversion("audio/mp4")).toBe(true);
    expect(bridgeAudioNeedsConversion("audio/webm;codecs=opus")).toBe(true);
  });

  test("planBridgeAudioSend: ogg e convertido vão como áudio; sem conversão vira documento", () => {
    expect(planBridgeAudioSend({ fileMimeType: "audio/ogg", fileName: "a.ogg", converted: false })).toEqual({
      kind: "audio",
      sendMime: "audio/ogg",
      useConverted: false,
      voiceFields: { PTT: true, MimeType: "audio/ogg; codecs=opus" },
    });
    // Convertido: o data-URI leva só `audio/ogg` (o gateway recusa espaço depois
    // do `;`); o codec vai no campo MimeType do corpo.
    expect(planBridgeAudioSend({ fileMimeType: "audio/mp4", fileName: "a.m4a", converted: true })).toEqual({
      kind: "audio",
      sendMime: "audio/ogg",
      useConverted: true,
      voiceFields: { PTT: true, MimeType: "audio/ogg; codecs=opus" },
    });
    // Gravação do Firefox ("audio/ogg; codecs=opus"): o parâmetro nunca vai para o data-URI.
    expect(planBridgeAudioSend({ fileMimeType: "audio/ogg; codecs=opus", fileName: "a.ogg", converted: false }).sendMime).toBe("audio/ogg");
    expect(toDataUri(new Uint8Array([79, 103]), "audio/ogg; codecs=opus")).toBe("data:audio/ogg;base64,T2c=");
    expect(toDataUri(new Uint8Array([79, 103]), "")).toBe("data:application/octet-stream;base64,T2c=");
    expect(planBridgeAudioSend({ fileMimeType: "audio/mp4", fileName: "nota-de-voz-1.m4a", converted: false })).toEqual({
      kind: "document",
      sendMime: "audio/mp4",
      useConverted: false,
      filename: "nota-de-voz-1.m4a",
      note: BRIDGE_AUDIO_AS_DOCUMENT_NOTE,
    });
    // Gravação antiga do iPhone (audio/mp4 com nome .webm): o nome segue o tipo real.
    expect(
      planBridgeAudioSend({ fileMimeType: "audio/mp4;codecs=mp4a.40.2", fileName: "nota-de-voz-2.webm", converted: false })
    ).toMatchObject({ kind: "document", sendMime: "audio/mp4", filename: "nota-de-voz-2.m4a" });
    expect(
      planBridgeAudioSend({ fileMimeType: "audio/webm;codecs=opus", fileName: "nota-de-voz-3.webm", converted: false })
    ).toMatchObject({ kind: "document", sendMime: "audio/webm", filename: "nota-de-voz-3.webm" });
    expect(planBridgeAudioSend({ fileMimeType: "audio/mpeg", fileName: "musica", converted: false })).toMatchObject({
      kind: "document",
      filename: "musica.mp3",
    });
    expect(planBridgeAudioSend({ fileMimeType: "audio/x-desconhecido", fileName: "", converted: false })).toMatchObject({
      kind: "document",
      filename: "nota-de-voz",
    });
  });

  test("checkMetaWhatsappAudio: mp4/ogg/mpeg passam, webm falha com motivo claro", () => {
    expect(checkMetaWhatsappAudio("audio/mp4")).toEqual({ ok: true });
    expect(checkMetaWhatsappAudio("audio/ogg; codecs=opus")).toEqual({ ok: true });
    expect(checkMetaWhatsappAudio("audio/mpeg")).toEqual({ ok: true });
    // Mesmo contêiner mp4 com outro rótulo: segue saindo como antes.
    expect(checkMetaWhatsappAudio("audio/x-m4a")).toEqual({ ok: true });
    expect(checkMetaWhatsappAudio("audio/m4a")).toEqual({ ok: true });
    const webm = checkMetaWhatsappAudio("audio/webm;codecs=opus");
    expect(webm.ok).toBe(false);
    expect(webm.ok ? "" : webm.detail).toMatch(/webm/);
    expect(webm.ok ? "" : webm.detail).toContain("WhatsApp oficial (Meta)");
    const wav = checkMetaWhatsappAudio("audio/wav");
    expect(wav.ok ? "" : wav.detail).toMatch(/audio\/wav/);
  });

  test("buildBridgeMediaSendRequest — image with caption", () => {
    const req = buildBridgeMediaSendRequest({
      baseUrl: BASE_URL,
      token: TOKEN,
      toPhone: "15550000001",
      kind: "image",
      dataUri: "data:image/jpeg;base64,QUJD",
      caption: "Veja",
      filename: "ignored.jpg",
    });
    expect(req.url).toBe("https://wuzapi.example.com/chat/send/image");
    expect(req.headers.token).toBe(TOKEN);
    const body = JSON.parse(req.body);
    expect(body).toEqual({
      Phone: "15550000001",
      Image: "data:image/jpeg;base64,QUJD",
      Caption: "Veja",
    });
  });

  test("buildBridgeMediaSendRequest — audio never carries a caption", () => {
    const req = buildBridgeMediaSendRequest({
      baseUrl: BASE_URL,
      token: TOKEN,
      toPhone: "15550000001",
      kind: "audio",
      dataUri: "data:audio/ogg;base64,QUJD",
      caption: "should be dropped",
    });
    expect(req.url).toContain("/chat/send/audio");
    const body = JSON.parse(req.body);
    expect(body).toEqual({ Phone: "15550000001", Audio: "data:audio/ogg;base64,QUJD" });
  });

  test("buildBridgeMediaSendRequest — document carries FileName", () => {
    const req = buildBridgeMediaSendRequest({
      baseUrl: BASE_URL,
      token: TOKEN,
      toPhone: "15550000001",
      kind: "document",
      dataUri: "data:application/pdf;base64,QUJD",
      filename: "contrato.pdf",
    });
    expect(req.url).toContain("/chat/send/document");
    const body = JSON.parse(req.body);
    expect(body).toEqual({
      Phone: "15550000001",
      Document: "data:application/pdf;base64,QUJD",
      FileName: "contrato.pdf",
    });
  });

  test("buildBridgeMediaSendRequest — video with empty caption omits Caption", () => {
    const req = buildBridgeMediaSendRequest({
      baseUrl: BASE_URL,
      token: TOKEN,
      toPhone: "15550000001",
      kind: "video",
      dataUri: "data:video/mp4;base64,QUJD",
      caption: "",
    });
    expect(req.url).toContain("/chat/send/video");
    const body = JSON.parse(req.body);
    expect(body).toEqual({ Phone: "15550000001", Video: "data:video/mp4;base64,QUJD" });
  });
});

// Regressão do piloto U6: mensagem de voz vem com mimetype parametrizado
// ("audio/ogg; codecs=opus") — o data-URI tem ';' extra e o parse deve ser
// pela primeira vírgula, senão o atob recebe o "data:" cru e explode.
describe("piloto U6 — data-URI com mimetype parametrizado", () => {
  test("voice note data-URI é decodificado e o mime preservado", () => {
    const payload = `data:audio/ogg; codecs=opus;base64,${btoa("fake-ogg-bytes")}`;
    const result = parseBridgeDownloadResponse(true, 200, {
      code: 200,
      success: true,
      data: { Data: payload },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(atob(result.base64)).toBe("fake-ogg-bytes");
    expect(result.mimeType).toBe("audio/ogg; codecs=opus");
  });
});
