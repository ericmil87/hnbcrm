import { describe, expect, test } from "vitest";
import {
  META_AD_WINDOW_MS,
  META_WINDOW_MS,
  TEXT_LIMIT,
  buildMediaPayload,
  buildSenderActionPayload,
  buildTextPayload,
  classifyMetaError,
  mediaKindForMime,
  metaConversationWindow,
  metaWindowClosesAt,
  parseHnbMetadata,
  serviceWindowState,
  splitMetaText,
  viaAppFor,
} from "./lib/metaSend";

const bytes = (s: string) => new TextEncoder().encode(s).length;
const chars = (s: string) => Array.from(s).length;

describe("splitMetaText", () => {
  test("texto curto sai inteiro (aparado)", () => {
    expect(splitMetaText("  Olá, tudo bem?  ", "instagram")).toEqual(["Olá, tudo bem?"]);
    expect(splitMetaText("   ", "messenger")).toEqual([]);
  });

  test("Instagram mede BYTES: acentos e emoji contam mais de 1", () => {
    // 600 "ç" = 1200 bytes (> 1000) mas só 600 caracteres.
    const text = "ç".repeat(600);
    const parts = splitMetaText(text, "instagram");
    expect(parts.length).toBe(2);
    for (const p of parts) expect(bytes(p)).toBeLessThanOrEqual(TEXT_LIMIT.instagram.max);
    expect(parts.join("")).toBe(text);
    // No Messenger o mesmo texto cabe numa mensagem só.
    expect(splitMetaText(text, "messenger")).toEqual([text]);
  });

  test("nunca corta no meio de um emoji (nem de sequência ZWJ)", () => {
    const family = "👨‍👩‍👧‍👦"; // 25 bytes, vários code points
    const text = family.repeat(100); // 2500 bytes, sem espaços
    const parts = splitMetaText(text, "instagram");
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(bytes(p)).toBeLessThanOrEqual(1000);
      expect(p.length % family.length).toBe(0); // só famílias inteiras
    }
    expect(parts.join("")).toBe(text);
  });

  test("Messenger mede caracteres com teto de trabalho de 1900", () => {
    const text = "a".repeat(3000);
    const parts = splitMetaText(text, "messenger");
    expect(parts.map(chars)).toEqual([1900, 1100]);
    expect(TEXT_LIMIT.messenger).toEqual({ unit: "chars", max: 2000 });
  });

  test("prefere parágrafo, depois frase, depois palavra", () => {
    const p1 = "Primeiro parágrafo. " + "x".repeat(950);
    const p2 = "Segundo parágrafo com acentuação ção.";
    const parts = splitMetaText(`${p1}\n\n${p2}`, "instagram");
    expect(parts).toEqual([p1, p2]);

    const s1 = "Frase um " + "y".repeat(600) + ".";
    const s2 = "Frase dois " + "z".repeat(600) + ".";
    expect(splitMetaText(`${s1} ${s2}`, "instagram")).toEqual([s1, s2]);

    const words = Array.from({ length: 300 }, (_, i) => `palavra${i}`).join(" ");
    const wp = splitMetaText(words, "instagram");
    expect(wp.length).toBeGreaterThan(1);
    for (const p of wp) {
      expect(bytes(p)).toBeLessThanOrEqual(1000);
      expect(p).toMatch(/^palavra\d+( palavra\d+)*$/); // nenhuma palavra partida
    }
    expect(wp.join(" ")).toBe(words);
  });
});

describe("payloads", () => {
  test("RESPONSE só no Messenger; metadata hnb: nos dois", () => {
    const m = buildTextPayload("messenger", "100", "Oi", { messageId: "msg1" });
    expect(m).toEqual({
      recipient: { id: "100" },
      messaging_type: "RESPONSE",
      message: { text: "Oi", metadata: "hnb:msg1" },
    });
    const ig = buildTextPayload("instagram", "200", "Oi", { messageId: "msg2" });
    expect(ig).toEqual({ recipient: { id: "200" }, message: { text: "Oi", metadata: "hnb:msg2" } });
    expect("messaging_type" in ig).toBe(false);
  });

  test("reply_to.mid quando houver citação", () => {
    const p = buildTextPayload("instagram", "200", "Oi", { messageId: "m", replyToMid: "mid_x" });
    expect(p.reply_to).toEqual({ mid: "mid_x" });
    expect(buildTextPayload("messenger", "1", "a", { messageId: "m" }).reply_to).toBeUndefined();
  });

  test("sender_action, mídia e mime", () => {
    expect(buildSenderActionPayload("1", "mark_seen")).toEqual({ recipient: { id: "1" }, sender_action: "mark_seen" });
    const media = buildMediaPayload("messenger", "1", "image", "https://x/y.jpg", { messageId: "m" });
    expect(media.message).toEqual({
      attachment: { type: "image", payload: { url: "https://x/y.jpg", is_reusable: false } },
      metadata: "hnb:m",
    });
    expect(mediaKindForMime("instagram", "image/jpeg")).toBe("image");
    expect(mediaKindForMime("instagram", "audio/ogg; codecs=opus")).toBe("audio");
    expect(mediaKindForMime("instagram", "application/pdf")).toBe("file");
    expect(mediaKindForMime("instagram", "application/zip")).toBeNull();
    expect(mediaKindForMime("messenger", "application/zip")).toBe("file");
  });

  test("hnb: e app de origem do eco", () => {
    expect(parseHnbMetadata("hnb:abc")).toBe("abc");
    expect(parseHnbMetadata("outra")).toBeNull();
    expect(parseHnbMetadata(undefined)).toBeNull();
    expect(viaAppFor("263902037430900")).toBe("page_inbox");
    expect(viaAppFor("26390203743090")).toBe("page_inbox");
    expect(viaAppFor("123")).toBe("other");
    expect(viaAppFor(undefined)).toBe("unknown");
  });
});

describe("classifyMetaError", () => {
  const err = (code: number, subcode?: number) => ({
    error: { code, ...(subcode !== undefined ? { error_subcode: subcode } : {}), message: "x" },
  });
  test.each([
    [400, err(190), "token_invalid"],
    [400, err(613), "rate_limited"],
    [400, err(4), "rate_limited"],
    [400, err(551), "user_unavailable"],
    [400, err(1545041), "user_unavailable"],
    [400, err(10, 2018300), "no_thread_control"],
    [400, err(10), "permission"],
    [400, err(10, 2018278), "outside_window"],
    [400, err(100), "bad_request"],
    [500, {}, "transient"],
    [503, err(2), "transient"],
    [0, {}, "transient"],
  ])("HTTP %s %j → %s", (status, body, kind) => {
    expect(classifyMetaError(status, body).kind).toBe(kind);
  });

  test("cópias PT-BR e código preservado", () => {
    const thread = classifyMetaError(400, err(10, 2018300));
    expect(thread.userMessage).toBe(
      "Outro app (ex. Caixa de entrada do Meta Business Suite) controla esta conversa. Defina o HNBCRM como app padrão em Configurações da Página > Mensagens avançadas."
    );
    expect(thread).toMatchObject({ code: 10, subcode: 2018300 });
    expect(classifyMetaError(400, err(190)).userMessage).toMatch(/reconectado/);
    // O texto da Meta nunca vira a cópia (pode citar ids).
    expect(classifyMetaError(400, { error: { code: 100, message: "id 1000000000000002" } }).userMessage).not.toContain(
      "1000000000000002"
    );
  });
});

describe("janela de serviço", () => {
  const now = 1_800_000_000_000;
  test("24 h e 7 dias; sem inbound = fechada", () => {
    expect(serviceWindowState("instagram", undefined, false, now)).toEqual({ open: false });
    expect(serviceWindowState("instagram", now - 1000, false, now)).toEqual({ open: true, closesAt: now - 1000 + META_WINDOW_MS });
    expect(serviceWindowState("messenger", now - META_WINDOW_MS - 1, false, now).open).toBe(false);
    expect(serviceWindowState("messenger", now - 3 * META_WINDOW_MS, true, now)).toEqual({
      open: true,
      closesAt: now - 3 * META_WINDOW_MS + META_AD_WINDOW_MS,
    });
    expect(serviceWindowState("messenger", now - META_AD_WINDOW_MS, true, now).open).toBe(false);
  });

  test("conversa: maior entre 24 h da última inbound e 7 dias do anúncio", () => {
    const adAt = now - 3 * META_WINDOW_MS;
    const conv = { lastInboundAt: now - 2 * META_WINDOW_MS, windowOpenedByAdAt: adAt };
    expect(metaConversationWindow("messenger", conv, now)).toEqual({ open: true, closesAt: adAt + META_AD_WINDOW_MS });
    expect(metaConversationWindow("instagram", { lastInboundAt: now - 2 * META_WINDOW_MS }, now).open).toBe(false);
    expect(metaWindowClosesAt({})).toBeNull();
    expect(metaWindowClosesAt({ lastInboundAt: 10 })).toBe(10 + META_WINDOW_MS);
  });
});
