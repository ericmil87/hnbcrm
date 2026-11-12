import { describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_MAX_BYTES,
  attachmentTurnLabel,
  gateForErrorCode,
  toStreamAttachment,
  uploadAttachmentFile,
  validateAttachmentFile,
  validateAttachmentUrl,
  validateVoiceSize,
} from "./onboardingAttachments";

describe("validateAttachmentUrl", () => {
  it("aceita https e normaliza", () => {
    const r = validateAttachmentUrl("  https://www.instagram.com/loja  ");
    expect(r).toEqual({ ok: true, url: "https://www.instagram.com/loja" });
  });
  it.each(["", "http://site.com", "loja.com.br", "javascript:alert(1)", "https://", "https://localhost", "https://u:p@site.com", "https://a b.com"])(
    "recusa %j",
    (v) => expect(validateAttachmentUrl(v).ok).toBe(false)
  );
  it("recusa endereço longo demais", () => {
    expect(validateAttachmentUrl(`https://site.com/${"a".repeat(2000)}`).ok).toBe(false);
  });
});

describe("validateAttachmentFile", () => {
  it("PDF por tipo ou extensão, até 20 MB", () => {
    expect(validateAttachmentFile("pdf", { name: "a.pdf", type: "application/pdf", size: 10 })).toEqual({ ok: true, mimeType: "application/pdf" });
    expect(validateAttachmentFile("pdf", { name: "a.PDF", type: "", size: 10 }).ok).toBe(true);
    expect(validateAttachmentFile("pdf", { name: "a.pdf", type: "application/pdf", size: ATTACHMENT_MAX_BYTES.pdf + 1 }).ok).toBe(false);
    expect(validateAttachmentFile("pdf", { name: "a.png", type: "image/png", size: 10 }).ok).toBe(false);
  });
  it("imagem JPG/PNG/WebP até 5 MB", () => {
    expect(validateAttachmentFile("image", { name: "f.jpg", type: "", size: 10 })).toEqual({ ok: true, mimeType: "image/jpeg" });
    expect(validateAttachmentFile("image", { name: "f.png", type: "image/png", size: ATTACHMENT_MAX_BYTES.image }).ok).toBe(true);
    expect(validateAttachmentFile("image", { name: "f.png", type: "image/png", size: ATTACHMENT_MAX_BYTES.image + 1 }).ok).toBe(false);
    expect(validateAttachmentFile("image", { name: "f.gif", type: "image/gif", size: 10 }).ok).toBe(false);
    expect(validateAttachmentFile("image", { name: "f.png", type: "image/png", size: 0 }).ok).toBe(false);
  });
});

describe("validateVoiceSize", () => {
  it("limite de 2 MB e gravação vazia", () => {
    expect(validateVoiceSize(2 * 1024 * 1024).ok).toBe(true);
    expect(validateVoiceSize(2 * 1024 * 1024 + 1).ok).toBe(false);
    expect(validateVoiceSize(0).ok).toBe(false);
  });
});

describe("uploadAttachmentFile", () => {
  const blob = new Blob(["abc"], { type: "application/pdf" });
  it("gera a URL, sobe com o Content-Type e salva; devolve o storageId", async () => {
    const generateUploadUrl = vi.fn(async () => "https://up.convex.cloud/x");
    const saveFile = vi.fn(async () => "file1");
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ storageId: "st1" }) }) as unknown as Response);
    const phases: string[] = [];
    const id = await uploadAttachmentFile(
      { organizationId: "org1", generateUploadUrl, saveFile, fetchImpl },
      { blob, name: "c.pdf", mimeType: "application/pdf" },
      (p) => phases.push(p)
    );
    expect(id).toBe("st1");
    expect(generateUploadUrl).toHaveBeenCalledWith({ organizationId: "org1" });
    expect(fetchImpl).toHaveBeenCalledWith("https://up.convex.cloud/x", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: blob });
    expect(saveFile).toHaveBeenCalledWith({
      organizationId: "org1",
      storageId: "st1",
      name: "c.pdf",
      mimeType: "application/pdf",
      size: 3,
      fileType: "message_attachment",
    });
    expect(phases).toEqual(["uploading", "saving"]);
  });
  it("saveFile falha depois do POST: descarta o blob e repassa o erro", async () => {
    const discardUnsaved = vi.fn(async () => true);
    const saveFile = vi.fn(async () => {
      throw new Error("quota");
    });
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ storageId: "st9" }) }) as unknown as Response);
    await expect(
      uploadAttachmentFile({ organizationId: "o", generateUploadUrl: async () => "u", saveFile, discardUnsaved, fetchImpl }, { blob, name: "a", mimeType: "application/pdf" })
    ).rejects.toThrow("quota");
    expect(discardUnsaved).toHaveBeenCalledWith({ organizationId: "o", storageId: "st9" });
  });
  it("falha do POST não chama saveFile", async () => {
    const saveFile = vi.fn();
    const fetchImpl = vi.fn(async () => ({ ok: false }) as unknown as Response);
    await expect(
      uploadAttachmentFile({ organizationId: "o", generateUploadUrl: async () => "u", saveFile, fetchImpl }, { blob, name: "a", mimeType: "application/pdf" })
    ).rejects.toThrow();
    expect(saveFile).not.toHaveBeenCalled();
  });
});

describe("anexo do turno", () => {
  it("monta o attachment do SSE", () => {
    expect(toStreamAttachment({ kind: "url", url: "https://a.com/" })).toEqual({ kind: "url", url: "https://a.com/" });
    expect(toStreamAttachment({ kind: "audio", file: new Blob(), name: "n", mimeType: "audio/webm" }, "st")).toEqual({ kind: "audio", storageId: "st" });
    expect(() => toStreamAttachment({ kind: "pdf", file: new Blob(), name: "n", mimeType: "application/pdf" })).toThrow();
  });
  it("rótulos e portões", () => {
    expect(attachmentTurnLabel({ kind: "url", url: "https://www.site.com/x" })).toBe("Link: www.site.com");
    expect(attachmentTurnLabel({ kind: "pdf", file: new Blob(), name: "c.pdf", mimeType: "" })).toBe("PDF: c.pdf");
    expect(gateForErrorCode("email_unverified")).toBe("cartaoConta");
    expect(gateForErrorCode("notice_required")).toBe("avisoMateriais");
    expect(gateForErrorCode("network")).toBeNull();
    expect(gateForErrorCode(null)).toBeNull();
  });
});
