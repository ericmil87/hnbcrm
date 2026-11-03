import { describe, expect, test } from "vitest";
import {
  QUOTA_LIMITS,
  checkLinkQuota,
  checkOrgQuota,
  classifyTelegramMedia,
  extensionOf,
  fileSizeCopy,
  fileTooBigCopy,
  fileTypeRefusedCopy,
  hourStartOf,
  isAllowedDocument,
  localDayKey,
  quotaRefusalCopy,
} from "./telegramQuota";

const TZ = "America/Sao_Paulo"; // UTC-3
const MB = 1024 * 1024;
// 2026-11-03 11:30 local = 14:30Z
const NOW = Date.UTC(2026, 10, 3, 14, 30, 15);

describe("quota por vínculo", () => {
  test("primeiro arquivo abre os baldes", () => {
    const r = checkLinkQuota(undefined, { now: NOW, tz: TZ, bytes: 2 * MB });
    expect(r).toEqual({
      ok: true,
      next: { hourStart: Date.UTC(2026, 10, 3, 14, 0), filesThisHour: 1, dayKey: "2026-11-03", bytesToday: 2 * MB },
    });
  });

  test("o 31º arquivo da hora é recusado e libera na próxima hora cheia", () => {
    const quota = { hourStart: hourStartOf(NOW, TZ), filesThisHour: 30, dayKey: "2026-11-03", bytesToday: 1 };
    const r = checkLinkQuota(quota, { now: NOW, tz: TZ, bytes: 1 });
    expect(r).toEqual({ ok: false, reason: "hour", retryAt: Date.UTC(2026, 10, 3, 15, 0) });
    expect(quotaRefusalCopy("hour", Date.UTC(2026, 10, 3, 15, 0), TZ)).toBe(
      "⏳ Você já enviou 30 arquivos nesta hora pelo Telegram. Libera às 12:00. Enquanto isso, use o CRM.",
    );
  });

  test("virada da hora zera o contador de arquivos mas não os bytes do dia", () => {
    const quota = { hourStart: hourStartOf(NOW, TZ), filesThisHour: 30, dayKey: "2026-11-03", bytesToday: 10 * MB };
    const next = checkLinkQuota(quota, { now: NOW + 3_600_000, tz: TZ, bytes: MB });
    expect(next).toMatchObject({ ok: true, next: { filesThisHour: 1, bytesToday: 11 * MB } });
  });

  test("teto de bytes do dia; o dia vira à meia-noite LOCAL", () => {
    const quota = { hourStart: hourStartOf(NOW, TZ), filesThisHour: 1, dayKey: "2026-11-03", bytesToday: 149 * MB };
    const refused = checkLinkQuota(quota, { now: NOW, tz: TZ, bytes: 2 * MB });
    // Next local midnight = 03:00Z of the 4th.
    expect(refused).toEqual({ ok: false, reason: "day_bytes", retryAt: Date.UTC(2026, 10, 4, 3, 0) });
    expect(checkLinkQuota(quota, { now: NOW, tz: TZ, bytes: MB }).ok).toBe(true);
    // 02:59Z is still the 3rd locally (23:59); 03:00Z is the 4th.
    expect(localDayKey(Date.UTC(2026, 10, 4, 2, 59), TZ)).toBe("2026-11-03");
    expect(localDayKey(Date.UTC(2026, 10, 4, 3, 0), TZ)).toBe("2026-11-04");
    const afterMidnight = checkLinkQuota(quota, { now: Date.UTC(2026, 10, 4, 3, 5), tz: TZ, bytes: 100 * MB });
    expect(afterMidnight).toMatchObject({ ok: true, next: { dayKey: "2026-11-04", bytesToday: 100 * MB } });
    expect(refused.ok === false && quotaRefusalCopy(refused.reason, refused.retryAt, TZ)).toBe(
      "📦 Você já enviou 150 MB em arquivos hoje pelo Telegram. Libera às 00:00 de amanhã. Enquanto isso, use o CRM.",
    );
  });
});

describe("quota da org", () => {
  test("500 por dia local", () => {
    expect(checkOrgQuota(undefined, { now: NOW, tz: TZ, bytes: MB })).toEqual({ ok: true, next: { dayKey: "2026-11-03", files: 1, bytes: MB } });
    const full = { dayKey: "2026-11-03", files: QUOTA_LIMITS.filesPerDayPerOrg, bytes: 0 };
    const r = checkOrgQuota(full, { now: NOW, tz: TZ });
    expect(r).toEqual({ ok: false, reason: "org_day", retryAt: Date.UTC(2026, 10, 4, 3, 0) });
    expect(checkOrgQuota(full, { now: Date.UTC(2026, 10, 4, 3, 1), tz: TZ }).ok).toBe(true);
    expect(quotaRefusalCopy("org_day", Date.UTC(2026, 10, 4, 3, 0), TZ)).toContain("500 arquivos hoje");
  });
});

describe("textos", () => {
  test("tamanhos", () => {
    expect(fileSizeCopy(24 * MB)).toBe("24 MB");
    expect(fileSizeCopy(3.1 * MB)).toBe("3,1 MB");
    expect(fileSizeCopy(820 * 1024)).toBe("820 KB");
    expect(fileSizeCopy(512)).toBe("512 B");
  });
  test("arquivo grande e tipo recusado (§4.5)", () => {
    expect(fileTooBigCopy(24 * MB)).toBe("📦 Esse arquivo tem 24 MB; o máximo pelo Telegram é 20 MB. Mande pelo CRM.");
    expect(fileTypeRefusedCopy(".exe")).toBe(
      "🚫 Tipo de arquivo não permitido (.exe). Aceito PDF, imagens, áudio, Office, CSV, TXT e ZIP.",
    );
    expect(fileTypeRefusedCopy("")).not.toContain("()");
    expect(fileTypeRefusedCopy(".<b>")).toContain("&lt;b&gt;");
  });
});

describe("allowlist (a do inbound)", () => {
  test("aceita e recusa por mime", () => {
    expect(isAllowedDocument("a.pdf", "application/pdf")).toBe(true);
    expect(isAllowedDocument("a.zip", "application/zip")).toBe(true);
    expect(isAllowedDocument("a.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe(true);
    expect(isAllowedDocument("a.csv", "text/csv; charset=utf-8")).toBe(true);
    expect(isAllowedDocument("a.exe", "application/x-msdownload")).toBe(false);
    expect(isAllowedDocument("a.mp4", "video/mp4")).toBe(false);
  });
  test("mime ausente ou genérico cai na extensão", () => {
    expect(isAllowedDocument("Proposta.XLSX", undefined)).toBe(true);
    expect(isAllowedDocument("a.docx", "application/octet-stream")).toBe(true);
    expect(isAllowedDocument("a.exe", "application/octet-stream")).toBe(false);
    expect(isAllowedDocument("semextensao", undefined)).toBe(false);
    expect(extensionOf("Foto.JPG")).toBe(".jpg");
    expect(extensionOf("x")).toBe("");
  });
});

describe("classifyTelegramMedia", () => {
  test("foto: maior tamanho; voz; áudio; documento; vídeo; nota de vídeo; sticker; nada", () => {
    expect(
      classifyTelegramMedia({ photo: [{ file_id: "s", file_size: 100 }, { file_id: "l", file_size: 900 }] }),
    ).toEqual({ kind: "photo", fileId: "l", fileSize: 900, mime: "image/jpeg", fileName: undefined });
    expect(classifyTelegramMedia({ voice: { file_id: "v", file_size: 5, mime_type: "audio/ogg" } })).toMatchObject({ kind: "voice", fileId: "v", mime: "audio/ogg" });
    expect(classifyTelegramMedia({ audio: { file_id: "a", file_name: "m.mp3" } })).toMatchObject({ kind: "audio", fileName: "m.mp3" });
    expect(classifyTelegramMedia({ document: { file_id: "d", file_name: "x.pdf", mime_type: "application/pdf", file_size: 7 } })).toEqual({
      kind: "document", fileId: "d", fileSize: 7, mime: "application/pdf", fileName: "x.pdf",
    });
    expect(classifyTelegramMedia({ video: { file_id: "vv" } }).kind).toBe("video");
    expect(classifyTelegramMedia({ animation: { file_id: "gif" } }).kind).toBe("video");
    expect(classifyTelegramMedia({ video_note: { file_id: "n" } }).kind).toBe("video_note");
    expect(classifyTelegramMedia({ sticker: { file_id: "s" } }).kind).toBe("sticker");
    expect(classifyTelegramMedia({ text: "oi" })).toEqual({ kind: "none" });
    expect(classifyTelegramMedia(null)).toEqual({ kind: "none" });
    expect(classifyTelegramMedia({ photo: [] })).toEqual({ kind: "none" });
    expect(classifyTelegramMedia({ document: { file_size: 3 } })).toEqual({ kind: "none" });
  });
});
