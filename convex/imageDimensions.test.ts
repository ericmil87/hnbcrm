/// <reference types="vite/client" />
/**
 * Dimensões de imagem em `files` (`width`/`height`): quem grava (mídia
 * recebida, upload da equipe, cópia do encaminhamento, backfill) e quem
 * devolve (`getMessages`). Mensagem antiga, sem dimensões, sai como antes.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { jpegBytes, pngBytes } from "./lib/imageSize.testkit";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

type T = TestConvex<typeof schema>;

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seed(t: T) {
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Imagens",
      slug: `org-imagens-${Math.random().toString(36).slice(2)}`,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", {});
    const teamMemberId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId,
      channel: "webchat",
      status: "active",
      messageCount: 0,
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, userId, teamMemberId, conversationId };
  });
  return { ...ids, asAdmin: t.withIdentity({ subject: `${ids.userId}|s1` }) };
}

async function storeBlob(t: T, bytes: Uint8Array = new Uint8Array([1, 2, 3])) {
  return await t.run(async (ctx) => await ctx.storage.store(new Blob([bytes as BlobPart])));
}

async function fileRow(t: T, fileId: Id<"files">) {
  return await t.run(async (ctx) => await ctx.db.get(fileId));
}

async function messageWith(
  t: T,
  s: { organizationId: Id<"organizations">; conversationId: Id<"conversations"> },
  attachments: Id<"files">[]
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      organizationId: s.organizationId,
      conversationId: s.conversationId,
      direction: "inbound",
      senderType: "contact",
      content: "",
      contentType: "image",
      isInternal: false,
      attachments,
      createdAt: Date.now(),
    })
  );
}

describe("files.saveFile — dimensões medidas pelo navegador", () => {
  test("par válido de imagem é gravado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const fileId = await s.asAdmin.mutation(api.files.saveFile, {
      organizationId: s.organizationId,
      storageId: await storeBlob(t),
      name: "foto.jpg",
      mimeType: "image/jpeg",
      size: 1000,
      fileType: "message_attachment",
      width: 1280,
      height: 720,
    });
    expect(await fileRow(t, fileId)).toMatchObject({ width: 1280, height: 720 });
  });

  test("cliente antigo (sem os campos) segue funcionando", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const fileId = await s.asAdmin.mutation(api.files.saveFile, {
      organizationId: s.organizationId,
      storageId: await storeBlob(t),
      name: "foto.jpg",
      mimeType: "image/jpeg",
      size: 1000,
      fileType: "message_attachment",
    });
    const row = await fileRow(t, fileId);
    expect(row?.width).toBeUndefined();
    expect(row?.height).toBeUndefined();
  });

  test("valor inválido ou arquivo que não é imagem: ignora, sem erro", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const cases: Array<{ mimeType: string; name: string; width?: number; height?: number }> = [
      { mimeType: "image/jpeg", name: "a.jpg", width: 0, height: 720 },
      { mimeType: "image/jpeg", name: "b.jpg", width: 1280.5, height: 720 },
      { mimeType: "image/jpeg", name: "c.jpg", width: 20001, height: 720 },
      { mimeType: "image/jpeg", name: "d.jpg", width: -1, height: 720 },
      { mimeType: "image/jpeg", name: "e.jpg", width: 1280 },
      { mimeType: "application/pdf", name: "f.pdf", width: 1280, height: 720 },
    ];
    for (const c of cases) {
      const fileId = await s.asAdmin.mutation(api.files.saveFile, {
        organizationId: s.organizationId,
        storageId: await storeBlob(t),
        size: 1000,
        fileType: "message_attachment",
        ...c,
      });
      const row = await fileRow(t, fileId);
      expect(row?.width, c.name).toBeUndefined();
      expect(row?.height, c.name).toBeUndefined();
    }
  });
});

describe("whatsapp.internalSaveInboundAttachment — mídia recebida", () => {
  test("grava as dimensões que a action leu dos bytes; sem elas, nada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const withSize = await t.mutation(internal.whatsapp.internalSaveInboundAttachment, {
      organizationId: s.organizationId,
      storageId: await storeBlob(t),
      name: "a.jpg",
      mimeType: "image/jpeg",
      size: 1000,
      width: 3000,
      height: 4000,
    });
    const without = await t.mutation(internal.whatsapp.internalSaveInboundAttachment, {
      organizationId: s.organizationId,
      storageId: await storeBlob(t),
      name: "b.ogg",
      mimeType: "audio/ogg",
      size: 1000,
      width: 3000,
      height: 4000,
    });
    if (!withSize.ok || !without.ok) throw new Error("anexo recusado");
    expect(await fileRow(t, withSize.fileId)).toMatchObject({ width: 3000, height: 4000 });
    expect((await fileRow(t, without.fileId))?.width).toBeUndefined();
  });
});

describe("getMessages / internalGetMessages — devolvem as dimensões", () => {
  test("anexo com dimensões leva width/height; anexo antigo mantém o shape", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const saved = await t.mutation(internal.whatsapp.internalSaveInboundAttachment, {
      organizationId: s.organizationId,
      storageId: await storeBlob(t),
      name: "nova.jpg",
      mimeType: "image/jpeg",
      size: 1000,
      width: 1080,
      height: 1920,
    });
    const old = await t.mutation(internal.whatsapp.internalSaveInboundAttachment, {
      organizationId: s.organizationId,
      storageId: await storeBlob(t),
      name: "antiga.jpg",
      mimeType: "image/jpeg",
      size: 1000,
    });
    if (!saved.ok || !old.ok) throw new Error("anexo recusado");
    await messageWith(t, s, [saved.fileId, old.fileId]);

    const viaApp = (await s.asAdmin.query(api.conversations.getMessages, {
      conversationId: s.conversationId,
    })) as any[];
    const viaRest = (await t.query(internal.conversations.internalGetMessages, {
      organizationId: s.organizationId,
      conversationId: s.conversationId,
    })) as any[];
    for (const msgs of [viaApp, viaRest]) {
      const [nova, antiga] = msgs[0].attachmentFiles;
      expect(nova).toMatchObject({ name: "nova.jpg", width: 1080, height: 1920 });
      expect(Object.keys(antiga).sort()).toEqual(["_id", "mimeType", "name", "size", "url"]);
    }
  });
});

describe("files.internalBackfillImageDimensions", () => {
  async function seedLegacy(t: T, s: { organizationId: Id<"organizations"> }) {
    const make = async (name: string, mimeType: string, bytes: Uint8Array, extra = {}) => {
      const storageId = await storeBlob(t, bytes);
      return await t.run(async (ctx) =>
        ctx.db.insert("files", {
          organizationId: s.organizationId,
          storageId,
          name,
          mimeType,
          size: bytes.byteLength,
          fileType: "message_attachment",
          createdAt: Date.now(),
          ...extra,
        })
      );
    };
    return {
      jpeg: await make("retrato.jpg", "image/jpeg", jpegBytes(4000, 3000, { orientation: 6 })),
      png: await make("print.png", "image/png", pngBytes(750, 1334)),
      broken: await make("quebrada.jpg", "image/jpeg", new Uint8Array(40)),
      audio: await make("voz.ogg", "audio/ogg", new Uint8Array(40)),
      done: await make("pronta.png", "image/png", pngBytes(10, 10), { width: 99, height: 98 }),
    };
  }

  /** O `fetch` da action devolve o blob do storage cuja URL foi pedida. */
  async function stubStorageFetch(t: T) {
    const byUrl = new Map<string, ArrayBuffer>();
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("files").take(50)) {
        const url = await ctx.storage.getUrl(row.storageId);
        const blob = await ctx.storage.get(row.storageId as Id<"_storage">);
        if (url && blob) byUrl.set(url, await blob.arrayBuffer());
      }
    });
    const ranges: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string> }) => {
      ranges.push(init?.headers?.Range ?? "");
      const body = byUrl.get(String(url));
      return body ? new Response(body, { status: 200 }) : new Response(null, { status: 404 });
    });
    return ranges;
  }

  test("dryRun (padrão) mede e não grava", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const ids = await seedLegacy(t, s);
    const ranges = await stubStorageFetch(t);

    const plan = await t.action(internal.files.internalBackfillImageDimensions, {});
    expect(plan).toMatchObject({
      dryRun: true,
      scanned: 5,
      candidates: 3,
      measured: 2,
      unreadable: 1,
      patched: 0,
      isDone: true,
    });
    expect(ranges.every((r) => r.startsWith("bytes=0-"))).toBe(true);
    expect((await fileRow(t, ids.jpeg))?.width).toBeUndefined();
  });

  test("real grava só o que mediu, é idempotente e não sobrescreve", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const ids = await seedLegacy(t, s);
    await stubStorageFetch(t);

    const first = await t.action(internal.files.internalBackfillImageDimensions, { dryRun: false });
    expect(first).toMatchObject({ dryRun: false, measured: 2, patched: 2, unreadable: 1 });
    expect(await fileRow(t, ids.jpeg)).toMatchObject({ width: 3000, height: 4000 });
    expect(await fileRow(t, ids.png)).toMatchObject({ width: 750, height: 1334 });
    expect((await fileRow(t, ids.broken))?.width).toBeUndefined();
    expect((await fileRow(t, ids.audio))?.width).toBeUndefined();
    expect(await fileRow(t, ids.done)).toMatchObject({ width: 99, height: 98 });

    const second = await t.action(internal.files.internalBackfillImageDimensions, { dryRun: false });
    expect(second).toMatchObject({ candidates: 1, measured: 0, patched: 0 });
  });
});

describe("forwardMessage — a cópia do anexo leva as dimensões", () => {
  test("linha nova de files, mesmo blob, mesmo width/height", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const saved = await t.mutation(internal.whatsapp.internalSaveInboundAttachment, {
      organizationId: s.organizationId,
      storageId: await storeBlob(t),
      name: "foto.jpg",
      mimeType: "image/jpeg",
      size: 1000,
      width: 640,
      height: 480,
    });
    if (!saved.ok) throw new Error("anexo recusado");
    const sourceId = await messageWith(t, s, [saved.fileId]);
    const targetId = await t.run(async (ctx) =>
      ctx.db.insert("conversations", {
        organizationId: s.organizationId,
        channel: "webchat",
        status: "active",
        messageCount: 0,
        lastMessageAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    await s.asAdmin.mutation(api.conversations.forwardMessage, {
      messageId: sourceId,
      targetConversationId: targetId,
    });

    const copy = await t.run(async (ctx) => {
      const message = (await ctx.db.query("messages").collect()).find(
        (m) => m.conversationId === targetId
      );
      return message?.attachments?.[0] ? await ctx.db.get(message.attachments[0]) : null;
    });
    expect(copy?._id).not.toBe(saved.fileId);
    expect(copy).toMatchObject({ width: 640, height: 480 });
  });
});
