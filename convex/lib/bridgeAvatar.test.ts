import { describe, expect, test } from "vitest";
import {
  MAX_AVATAR_BYTES,
  buildAvatarRequestBody,
  isAllowedAvatarUrl,
  parseAvatarResponse,
  readBodyCapped,
  sniffAvatarMime,
  validateAvatarBytes,
} from "./bridgeAvatar";
import { parseBridgeEvent } from "./bridgeParse";
import pictureFixtures from "../__fixtures__/bridgePictureEvent.json";

const URL_OK = "https://pps.whatsapp.net/v/t61/x.jpg?stp=dst-jpg&oe=6A0F1234";

describe("parseAvatarResponse", () => {
  test("ok com chaves minúsculas (formato medido)", () => {
    expect(
      parseAvatarResponse(200, { code: 200, success: true, data: { url: URL_OK, id: "1700000000", type: "preview" } })
    ).toEqual({ kind: "ok", url: URL_OK, pictureId: "1700000000" });
  });

  test("ok com chaves maiúsculas e sem envelope", () => {
    expect(parseAvatarResponse(200, { Data: { URL: URL_OK, ID: 42 } })).toEqual({
      kind: "ok",
      url: URL_OK,
      pictureId: "42",
    });
    expect(parseAvatarResponse(200, { url: URL_OK })).toEqual({ kind: "ok", url: URL_OK });
  });

  test("foto oculta, sem foto e sem avatar", () => {
    expect(parseAvatarResponse(500, { success: false, error: "user has hidden their profile picture" })).toEqual({
      kind: "hidden",
    });
    expect(parseAvatarResponse(500, { error: "user does not have a profile picture" })).toEqual({ kind: "none" });
    expect(parseAvatarResponse(500, "no avatar found")).toEqual({ kind: "none" });
  });

  test("429 e texto de rate limit", () => {
    expect(parseAvatarResponse(429, {})).toEqual({ kind: "rate_limited" });
    expect(parseAvatarResponse(500, { error: "rate-overlimit" })).toEqual({ kind: "rate_limited" });
  });

  test("lixo vira error, nunca lança", () => {
    expect(parseAvatarResponse(200, null)).toEqual({ kind: "error" });
    expect(parseAvatarResponse(200, "<html>")).toEqual({ kind: "error" });
    expect(parseAvatarResponse(200, { data: {} })).toEqual({ kind: "error" });
    expect(parseAvatarResponse(502, { error: "bad gateway" })).toEqual({ kind: "error" });
    expect(parseAvatarResponse(200, { success: false, error: "boom" })).toEqual({ kind: "error" });
  });
});

describe("validação do download", () => {
  test("só https e host .whatsapp.net", () => {
    expect(isAllowedAvatarUrl(URL_OK)).toBe(true);
    expect(isAllowedAvatarUrl("http://pps.whatsapp.net/x")).toBe(false);
    expect(isAllowedAvatarUrl("https://evil.example.com/x?a=.whatsapp.net")).toBe(false);
    expect(isAllowedAvatarUrl("https://whatsapp.net.evil.com/x")).toBe(false);
    expect(isAllowedAvatarUrl("https://user:pw@pps.whatsapp.net/x")).toBe(false);
    expect(isAllowedAvatarUrl("not a url")).toBe(false);
  });

  test("tipo pelos primeiros bytes e teto de 200 KB", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(60).fill(1)]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(sniffAvatarMime(jpeg)).toBe("image/jpeg");
    expect(sniffAvatarMime(png)).toBe("image/png");
    expect(sniffAvatarMime(webp)).toBe("image/webp");
    expect(sniffAvatarMime(new TextEncoder().encode("<html>"))).toBeNull();
    expect(validateAvatarBytes(jpeg)).toEqual({ mime: "image/jpeg", size: jpeg.length });
    expect(validateAvatarBytes(new Uint8Array(0))).toBeNull();
    const big = new Uint8Array(MAX_AVATAR_BYTES + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect(validateAvatarBytes(big)).toBeNull();
  });

  test("corpo pede a miniatura", () => {
    expect(JSON.parse(buildAvatarRequestBody("5511999990000"))).toEqual({ Phone: "5511999990000", Preview: true });
  });
});

describe("evento Picture (fixture SINTÉTICA)", () => {
  test("troca e remoção de usuário 1 a 1", () => {
    expect(parseBridgeEvent(pictureFixtures.changed)).toMatchObject({
      kind: "picture",
      picture: { phone: "15550000001", remove: false, pictureId: "1700000000" },
    });
    expect(parseBridgeEvent(pictureFixtures.removed)).toMatchObject({
      kind: "picture",
      picture: { phone: "15550000001", remove: true },
    });
  });

  test("grupo, LID, newsletter e lixo são ignorados", () => {
    expect(parseBridgeEvent(pictureFixtures.group).kind).toBe("ignored");
    expect(parseBridgeEvent(pictureFixtures.lid).kind).toBe("ignored");
    expect(parseBridgeEvent(pictureFixtures.newsletter).kind).toBe("ignored");
    expect(parseBridgeEvent({ type: "Picture", event: {} }).kind).toBe("ignored");
    expect(parseBridgeEvent({ type: "Picture", event: { JID: 5 } }).kind).toBe("ignored");
  });
});

describe("readBodyCapped", () => {
  test("lê até o teto e corta o que passa dele (stream)", async () => {
    const ok = await readBodyCapped(new Response(new Uint8Array(100).fill(1)), 200);
    expect(ok?.length).toBe(100);
    expect(await readBodyCapped(new Response(new Uint8Array(500)), 200)).toBeNull();
    const chunks = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(150));
      },
    });
    // Corpo sem fim: só termina porque a leitura é cortada no teto.
    expect(await readBodyCapped(new Response(chunks), 200)).toBeNull();
  });
});
