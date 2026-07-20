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
} from "./lib/bridgeSend";

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
