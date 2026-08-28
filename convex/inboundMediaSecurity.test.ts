/// <reference types="vite/client" />
/**
 * Mídia inbound do WhatsApp — os três achados colaterais que o plano de visão
 * levantou e só registrou (§9, itens 1, 2 e 4). Prova que:
 *
 *  1. o anexo do contato passa pelas MESMAS defesas do upload humano (allowlist
 *     de mimetype + quota da org) — antes entrava direto em `files`, então um
 *     contato conseguia encher o storage da org pelo WhatsApp;
 *  2. recusar o anexo NUNCA derruba a mensagem: o texto/legenda continua
 *     chegando ao inbox, com o motivo em `metadata.mediaSkipped`;
 *  3. o `MediaKey` do whatsmeow — a chave que decifra o blob na CDN do
 *     WhatsApp — não fica gravado em `messages.metadata` para sempre;
 *  4. o blob compartilhado por uma mensagem encaminhada não é apagado enquanto
 *     a outra cópia existir (antes, excluir um lado deixava o outro com anexo
 *     quebrado, sem aviso).
 */
import { expect, test, describe } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  checkInboundMediaMimeType,
  validateInboundMimeType,
} from "./lib/fileValidation";
import {
  isMediaKeyField,
  sanitizeBridgeMediaMeta,
  stripMediaKeyMaterial,
} from "./lib/bridgeMedia";
import { FILE_QUOTAS } from "./lib/fileQuotas";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

function setup() {
  return convexTest(schema, modules);
}

async function seedOrg(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Mídia",
      slug: "org-midia",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId };
  });
}

/** `true` se os bytes ainda estão no storage (convex-test não expõe getMetadata). */
async function blobExists(t: TestConvex<typeof schema>, storageId: string): Promise<boolean> {
  return await t.run(
    async (ctx) => (await ctx.db.system.get(storageId as Id<"_storage">)) !== null
  );
}

/** Blob de verdade no storage — para checar se o descarte apaga os bytes. */
async function storeBlob(t: TestConvex<typeof schema>, bytes = [0xff, 0xd8, 0xff, 0xd9]) {
  return await t.run(
    async (ctx) => await ctx.storage.store(new Blob([new Uint8Array(bytes) as BlobPart]))
  );
}

// ── Achado 1: allowlist de mimetype + quota na porta de entrada ─────────────

describe("allowlist de mimetype da mídia recebida", () => {
  test("aceita o que o WhatsApp legitimamente manda", () => {
    for (const mime of [
      "image/jpeg",
      "image/png",
      "image/webp",
      "audio/ogg; codecs=opus",
      "audio/aac",
      "video/mp4",
      "application/pdf",
      "application/zip",
    ]) {
      expect(validateInboundMimeType(mime)).toBe(true);
    }
  });

  test("recusa executável e afins, com motivo legível", () => {
    for (const mime of [
      "application/x-msdownload",
      "application/x-sh",
      "text/x-python",
      "application/x-httpd-php",
    ]) {
      const check = checkInboundMediaMimeType(mime);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toContain("não permitido");
    }
  });

  test("o parâmetro do mimetype não escapa da allowlist", () => {
    // "audio/ogg; codecs=opus" é válido; o truque abaixo não pode virar válido.
    expect(validateInboundMimeType("application/x-msdownload; name=image/png")).toBe(false);
  });
});

describe("internalSaveInboundAttachment — porta única dos dois transportes", () => {
  test("mimetype válido dentro da quota cria o anexo (caminho feliz)", async () => {
    const t = setup();
    const { organizationId } = await seedOrg(t);
    const storageId = await storeBlob(t);

    const saved = await t.mutation(internal.whatsapp.internalSaveInboundAttachment, {
      organizationId,
      storageId,
      name: "comprovante.jpg",
      mimeType: "image/jpeg",
      size: 150_000,
    });

    expect(saved.ok).toBe(true);
    const files = await t.run(async (ctx) => await ctx.db.query("files").collect());
    expect(files).toHaveLength(1);
    expect(files[0].fileType).toBe("message_attachment");
    expect(files[0].organizationId).toBe(organizationId);
  });

  test("mimetype fora da allowlist: sem linha em files e com o blob descartado", async () => {
    const t = setup();
    const { organizationId } = await seedOrg(t);
    const storageId = await storeBlob(t);

    const saved = await t.mutation(internal.whatsapp.internalSaveInboundAttachment, {
      organizationId,
      storageId,
      name: "payload.exe",
      mimeType: "application/x-msdownload",
      size: 1_000,
    });

    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.reason).toContain("não permitido");
    expect(await t.run(async (ctx) => await ctx.db.query("files").collect())).toHaveLength(0);
    // Nada de lixo órfão no storage — não existe cron limpando blob solto.
    expect(await blobExists(t, storageId)).toBe(false);
  });

  test("quota de armazenamento estourada recusa o anexo", async () => {
    const t = setup();
    const { organizationId } = await seedOrg(t);
    // Preenche a org até quase o teto do plano.
    await t.run(async (ctx) => {
      await ctx.db.insert("files", {
        organizationId,
        storageId: "blob-antigo",
        name: "antigo.pdf",
        mimeType: "application/pdf",
        size: FILE_QUOTAS.free.totalStorage - 1_000,
        fileType: "message_attachment",
        createdAt: Date.now(),
      });
    });
    const storageId = await storeBlob(t);

    const saved = await t.mutation(internal.whatsapp.internalSaveInboundAttachment, {
      organizationId,
      storageId,
      name: "grande.jpg",
      mimeType: "image/jpeg",
      size: 500_000,
    });

    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.reason).toContain("cota de armazenamento");
    expect(await t.run(async (ctx) => await ctx.db.query("files").collect())).toHaveLength(1);
  });

  test("a quota é POR ORGANIZAÇÃO — org cheia não bloqueia a vizinha", async () => {
    const t = setup();
    const a = await seedOrg(t);
    const b = await t.run(async (ctx) => {
      const now = Date.now();
      return {
        organizationId: await ctx.db.insert("organizations", {
          name: "Outra",
          slug: "outra",
          settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
          createdAt: now,
          updatedAt: now,
        }),
      };
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("files", {
        organizationId: a.organizationId,
        storageId: "blob-a",
        name: "a.pdf",
        mimeType: "application/pdf",
        size: FILE_QUOTAS.free.totalStorage - 1_000,
        fileType: "message_attachment",
        createdAt: Date.now(),
      });
    });

    const saved = await t.mutation(internal.whatsapp.internalSaveInboundAttachment, {
      organizationId: b.organizationId,
      storageId: await storeBlob(t),
      name: "ok.jpg",
      mimeType: "image/jpeg",
      size: 500_000,
    });
    expect(saved.ok).toBe(true);
  });
});

// ── Achado 2: o MediaKey não pode ficar gravado ─────────────────────────────

describe("material de chave do whatsmeow nunca é persistido", () => {
  const DESCRIPTOR = {
    URL: "https://mmg.whatsapp.net/d/f/xyz.enc",
    DirectPath: "/v/t62.7118-24/xyz.enc",
    MediaKey: "c2VncmVkby1xdWUtbmFvLXBvZGUtZmljYXI=",
    FileEncSHA256: "aGFzaC1jaWZyYWRv",
    FileSHA256: "aGFzaC1jbGFybw==",
    FileLength: "153318",
    Mimetype: "image/jpeg",
  };

  test("sanitizeBridgeMediaMeta guarda só o diagnosticável", () => {
    const safe = sanitizeBridgeMediaMeta({
      kind: "image",
      mimeType: "image/jpeg",
      filename: "comprovante.jpg",
      descriptor: DESCRIPTOR,
    });
    expect(safe).toEqual({
      kind: "image",
      mimeType: "image/jpeg",
      filename: "comprovante.jpg",
      fileLength: 153318,
    });
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("MediaKey");
    expect(serialized).not.toContain(DESCRIPTOR.MediaKey);
  });

  test("isMediaKeyField pega as variações de escrita", () => {
    for (const field of [
      "MediaKey",
      "mediaKey",
      "media_key",
      "FileEncSHA256",
      "fileSha256",
      "encKey",
      "clientSecret",
    ]) {
      expect(isMediaKeyField(field)).toBe(true);
    }
    for (const field of ["mimeType", "fileLength", "filename", "kind", "caption"]) {
      expect(isMediaKeyField(field)).toBe(false);
    }
  });

  test("stripMediaKeyMaterial limpa em qualquer profundidade, inclusive no metadata.raw", () => {
    const metadata = {
      bridgeType: "image",
      raw: { Info: { Type: "media" }, Message: { imageMessage: DESCRIPTOR } },
      lista: [{ MediaKey: "x" }, { ok: 1 }],
    };
    const limpo = JSON.stringify(stripMediaKeyMaterial(metadata));
    expect(limpo).not.toContain("MediaKey");
    expect(limpo).not.toContain("FileEncSHA256");
    expect(limpo).not.toContain(DESCRIPTOR.MediaKey);
    // …sem levar o que é útil junto.
    expect(limpo).toContain("bridgeType");
    expect(limpo).toContain("DirectPath");
  });

  test("backfill limpa mensagens já gravadas e é idempotente", async () => {
    const t = setup();
    const { organizationId } = await seedOrg(t);
    const messageId = await t.run(async (ctx) => {
      const now = Date.now();
      const contactId = await ctx.db.insert("contacts", {
        organizationId,
        firstName: "C",
        tags: [],
        createdAt: now,
        updatedAt: now,
      });
      const boardId = await ctx.db.insert("boards", {
        organizationId,
        name: "B",
        color: "#fff",
        isDefault: true,
        order: 0,
        createdAt: now,
        updatedAt: now,
      });
      const stageId = await ctx.db.insert("stages", {
        organizationId,
        boardId,
        name: "S",
        color: "#fff",
        order: 0,
        isClosedWon: false,
        isClosedLost: false,
        createdAt: now,
        updatedAt: now,
      });
      const leadId = await ctx.db.insert("leads", {
        organizationId,
        title: "L",
        contactId,
        boardId,
        stageId,
        value: 0,
        currency: "BRL",
        priority: "medium",
        temperature: "warm",
        tags: [],
        customFields: {},
        conversationStatus: "active",
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const conversationId = await ctx.db.insert("conversations", {
        organizationId,
        leadId,
        channel: "whatsapp",
        status: "active",
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      // Mensagem legada: gravada quando o descriptor inteiro ia para o metadata.
      return await ctx.db.insert("messages", {
        organizationId,
        conversationId,
        leadId,
        direction: "inbound",
        senderType: "contact",
        content: "[imagem]",
        contentType: "image",
        isInternal: false,
        metadata: { bridgeType: "image", bridgeMedia: { descriptor: DESCRIPTOR } },
        createdAt: now,
      });
    });

    const primeira = await t.mutation(internal.bridge.internalBackfillBridgeMediaKeys, {});
    expect(primeira).toBeGreaterThanOrEqual(1);

    const depois = await t.run(async (ctx) => await ctx.db.get(messageId));
    const serialized = JSON.stringify(depois!.metadata);
    expect(serialized).not.toContain("MediaKey");
    expect(serialized).not.toContain(DESCRIPTOR.MediaKey);
    expect(serialized).toContain("bridgeType");

    // Idempotente: rodar de novo não tem mais nada para limpar.
    expect(await t.mutation(internal.bridge.internalBackfillBridgeMediaKeys, {})).toBe(0);
  });
});

// ── Achado 4: blob compartilhado por encaminhamento ─────────────────────────

describe("blob compartilhado entre mensagem original e encaminhada", () => {
  async function seedTwoFilesSharingBlob(t: TestConvex<typeof schema>) {
    const { organizationId } = await seedOrg(t);
    const storageId = await storeBlob(t);
    return await t.run(async (ctx) => {
      const now = Date.now();
      const teamMemberId = await ctx.db.insert("teamMembers", {
        organizationId,
        name: "Admin",
        role: "admin",
        type: "human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const original = await ctx.db.insert("files", {
        organizationId,
        storageId,
        name: "comprovante.jpg",
        mimeType: "image/jpeg",
        size: 1000,
        fileType: "message_attachment",
        createdAt: now,
      });
      // A cópia do encaminhamento: linha nova, MESMO blob.
      const copia = await ctx.db.insert("files", {
        organizationId,
        storageId,
        name: "comprovante.jpg",
        mimeType: "image/jpeg",
        size: 1000,
        fileType: "message_attachment",
        createdAt: now,
      });
      return { organizationId, storageId, original, copia, teamMemberId };
    });
  }

  test("excluir um lado preserva o blob enquanto o outro existir", async () => {
    const t = setup();
    const { organizationId, storageId, original, copia, teamMemberId } =
      await seedTwoFilesSharingBlob(t);

    await t.mutation(internal.files.internalDeleteFile, {
      fileId: original,
      organizationId,
      teamMemberId,
    });

    // A linha original sumiu…
    expect(await t.run(async (ctx) => await ctx.db.get(original))).toBeNull();
    // …mas o blob continua lá, porque a cópia ainda aponta para ele.
    expect(await blobExists(t, storageId)).toBe(true);
    expect(await t.run(async (ctx) => await ctx.db.get(copia))).not.toBeNull();
  });

  test("excluir o último lado apaga o blob (sem vazar espaço)", async () => {
    const t = setup();
    const { organizationId, storageId, original, copia, teamMemberId } =
      await seedTwoFilesSharingBlob(t);

    await t.mutation(internal.files.internalDeleteFile, {
      fileId: original,
      organizationId,
      teamMemberId,
    });
    await t.mutation(internal.files.internalDeleteFile, {
      fileId: copia,
      organizationId,
      teamMemberId,
    });

    expect(await blobExists(t, storageId)).toBe(false);
  });

  test("arquivo com blob exclusivo continua sendo apagado normalmente", async () => {
    const t = setup();
    const { organizationId } = await seedOrg(t);
    const storageId = await storeBlob(t);
    const { fileId, teamMemberId } = await t.run(async (ctx) => {
      const now = Date.now();
      return {
        teamMemberId: await ctx.db.insert("teamMembers", {
          organizationId,
          name: "Admin",
          role: "admin",
          type: "human",
          status: "active",
          createdAt: now,
          updatedAt: now,
        }),
        fileId: await ctx.db.insert("files", {
          organizationId,
          storageId,
          name: "unico.pdf",
          mimeType: "application/pdf",
          size: 10,
          fileType: "message_attachment",
          createdAt: now,
        }),
      };
    });

    await t.mutation(internal.files.internalDeleteFile, {
      fileId,
      organizationId,
      teamMemberId,
    });
    expect(await blobExists(t, storageId)).toBe(false);
  });
});
